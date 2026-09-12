import type { LayoutNode } from "../types";

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverscanInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ViewportQueryOptions {
  overscan?: number | Partial<OverscanInsets>;
}

interface IndexedNode<TNode extends LayoutNode> {
  node: TNode;
  sequence: number;
  bottom: number;
  prefixMaxBottom: number;
}

const ZERO_OVERSCAN: OverscanInsets = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

/**
 * Incremental vertical spatial index for flow layouts.
 *
 * Nodes are kept sorted by their top edge. A prefix maximum of bottom edges
 * lets viewport queries binary-search past nodes that end above the window,
 * while a second binary search excludes nodes that start below it.
 *
 * The index is intentionally renderer-agnostic: it knows only layout geometry.
 * Masonry and future justified layouts can share it; the free-canvas renderer
 * will use a dedicated 2D spatial index instead.
 */
export class VerticalViewportIndex<TNode extends LayoutNode = LayoutNode> {
  #entries: IndexedNode<TNode>[] = [];
  readonly #mediaIds = new Set<string>();
  #nextSequence = 0;

  constructor(nodes: readonly TNode[] = []) {
    this.append(nodes);
  }

  get size(): number {
    return this.#entries.length;
  }

  append(nodes: readonly TNode[]): void {
    validateBatch(nodes, this.#mediaIds);
    if (nodes.length === 0) {
      return;
    }

    const added = nodes
      .map((node) => ({
        node: cloneNode(node),
        sequence: this.#nextSequence++,
        bottom: node.y + node.height,
        prefixMaxBottom: 0,
      }))
      .sort(compareByTopThenSequence);

    this.#entries = mergeEntries(this.#entries, added);
    recomputePrefixMaxBottom(this.#entries);

    for (const node of nodes) {
      this.#mediaIds.add(node.mediaId);
    }
  }

  query(
    viewport: ViewportRect,
    options: ViewportQueryOptions = {},
  ): readonly TNode[] {
    validateViewport(viewport);
    const overscan = normalizeOverscan(options.overscan);
    const window = expandViewport(viewport, overscan);

    if (this.#entries.length === 0) {
      return [];
    }

    const windowBottom = window.y + window.height;
    const first = firstPrefixBottomAtOrBelow(this.#entries, window.y);
    const endExclusive = firstTopBelow(this.#entries, windowBottom);

    if (first >= endExclusive) {
      return [];
    }

    const windowRight = window.x + window.width;
    const visible = this.#entries
      .slice(first, endExclusive)
      .filter(({ node, bottom }) => {
        const nodeRight = node.x + node.width;
        return (
          bottom >= window.y &&
          node.y <= windowBottom &&
          nodeRight >= window.x &&
          node.x <= windowRight
        );
      })
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ node }) => cloneNode(node));

    return visible;
  }

  snapshot(): readonly TNode[] {
    return [...this.#entries]
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ node }) => cloneNode(node));
  }
}

export function queryVisibleNodes<TNode extends LayoutNode>(
  nodes: readonly TNode[],
  viewport: ViewportRect,
  options: ViewportQueryOptions = {},
): readonly TNode[] {
  return new VerticalViewportIndex(nodes).query(viewport, options);
}

function mergeEntries<TNode extends LayoutNode>(
  existing: readonly IndexedNode<TNode>[],
  added: readonly IndexedNode<TNode>[],
): IndexedNode<TNode>[] {
  const merged: IndexedNode<TNode>[] = [];
  let existingIndex = 0;
  let addedIndex = 0;

  while (existingIndex < existing.length && addedIndex < added.length) {
    const left = existing[existingIndex];
    const right = added[addedIndex];
    if (compareByTopThenSequence(left, right) <= 0) {
      merged.push(left);
      existingIndex += 1;
    } else {
      merged.push(right);
      addedIndex += 1;
    }
  }

  while (existingIndex < existing.length) {
    merged.push(existing[existingIndex]);
    existingIndex += 1;
  }

  while (addedIndex < added.length) {
    merged.push(added[addedIndex]);
    addedIndex += 1;
  }

  return merged;
}

function compareByTopThenSequence<TNode extends LayoutNode>(
  left: IndexedNode<TNode>,
  right: IndexedNode<TNode>,
): number {
  return left.node.y - right.node.y || left.sequence - right.sequence;
}

function recomputePrefixMaxBottom<TNode extends LayoutNode>(
  entries: IndexedNode<TNode>[],
): void {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    maximum = Math.max(maximum, entry.bottom);
    entry.prefixMaxBottom = maximum;
  }
}

function firstPrefixBottomAtOrBelow<TNode extends LayoutNode>(
  entries: readonly IndexedNode<TNode>[],
  top: number,
): number {
  let low = 0;
  let high = entries.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle].prefixMaxBottom >= top) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low;
}

function firstTopBelow<TNode extends LayoutNode>(
  entries: readonly IndexedNode<TNode>[],
  bottom: number,
): number {
  let low = 0;
  let high = entries.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle].node.y <= bottom) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function expandViewport(
  viewport: ViewportRect,
  overscan: OverscanInsets,
): ViewportRect {
  return {
    x: viewport.x - overscan.left,
    y: viewport.y - overscan.top,
    width: viewport.width + overscan.left + overscan.right,
    height: viewport.height + overscan.top + overscan.bottom,
  };
}

function normalizeOverscan(
  value: ViewportQueryOptions["overscan"],
): OverscanInsets {
  if (value === undefined) {
    return { ...ZERO_OVERSCAN };
  }

  if (typeof value === "number") {
    requireFiniteNonNegative(value, "overscan");
    return {
      top: value,
      right: value,
      bottom: value,
      left: value,
    };
  }

  const normalized = {
    top: value.top ?? 0,
    right: value.right ?? 0,
    bottom: value.bottom ?? 0,
    left: value.left ?? 0,
  };

  for (const [name, amount] of Object.entries(normalized)) {
    requireFiniteNonNegative(amount, `overscan.${name}`);
  }

  return normalized;
}

function validateViewport(viewport: ViewportRect): void {
  requireFinite(viewport.x, "viewport.x");
  requireFinite(viewport.y, "viewport.y");
  requireFinitePositive(viewport.width, "viewport.width");
  requireFinitePositive(viewport.height, "viewport.height");
}

function validateBatch<TNode extends LayoutNode>(
  nodes: readonly TNode[],
  existingIds: ReadonlySet<string>,
): void {
  const batchIds = new Set<string>();

  for (const node of nodes) {
    if (node.mediaId.trim().length === 0) {
      throw new RangeError("mediaId must not be empty");
    }
    if (existingIds.has(node.mediaId) || batchIds.has(node.mediaId)) {
      throw new RangeError(`duplicate mediaId: ${node.mediaId}`);
    }

    requireFinite(node.x, `x for ${node.mediaId}`);
    requireFinite(node.y, `y for ${node.mediaId}`);
    requireFinitePositive(node.width, `width for ${node.mediaId}`);
    requireFinitePositive(node.height, `height for ${node.mediaId}`);
    batchIds.add(node.mediaId);
  }
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
}

function requireFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
}

function requireFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

function cloneNode<TNode extends LayoutNode>(node: TNode): TNode {
  return { ...node };
}
