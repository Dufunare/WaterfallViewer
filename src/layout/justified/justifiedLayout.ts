import type {
  LayoutNode,
  MediaVisualInfo,
  ViewportSize,
} from "../types";

export type { MediaVisualInfo, ViewportSize } from "../types";

export interface JustifiedLayoutConfig {
  viewport: ViewportSize;
  targetRowHeight: number;
  gap: number;
}

export interface JustifiedLayoutNode extends LayoutNode {
  rowIndex: number;
}

export interface JustifiedLayoutResult {
  nodes: readonly JustifiedLayoutNode[];
  totalHeight: number;
  rowCount: number;
  pendingCount: number;
}

/**
 * Incremental justified-row layout.
 *
 * Rows are immutable once emitted. The unfinished tail row stays pending until
 * enough media arrives to fill the viewport, or until `flushPending` is called
 * when a scan becomes terminal. This keeps the streaming path O(batch) without
 * requiring arbitrary removal/replacement support from the viewport index.
 */
export class JustifiedLayoutBuilder {
  readonly #config: JustifiedLayoutConfig;
  readonly #nodes: JustifiedLayoutNode[] = [];
  readonly #mediaIds = new Set<string>();
  #pending: MediaVisualInfo[] = [];
  #nextY = 0;
  #rowCount = 0;

  constructor(config: JustifiedLayoutConfig) {
    validateConfig(config);
    this.#config = cloneConfig(config);
  }

  get size(): number {
    return this.#nodes.length;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  get rowCount(): number {
    return this.#rowCount;
  }

  get totalHeight(): number {
    if (this.#rowCount === 0) {
      return 0;
    }
    return this.#nextY - this.#config.gap;
  }

  append(items: readonly MediaVisualInfo[]): readonly JustifiedLayoutNode[] {
    validateBatch(items, this.#mediaIds);
    const emitted: JustifiedLayoutNode[] = [];

    for (const item of items) {
      if (
        this.#pending.length > 0 &&
        this.#config.gap * this.#pending.length >= this.#config.viewport.width
      ) {
        emitted.push(...this.#finalizePending(false));
      }

      this.#pending.push(cloneVisual(item));
      this.#mediaIds.add(item.mediaId);

      if (rowWidthAtTargetHeight(this.#pending, this.#config) >= this.#config.viewport.width) {
        emitted.push(...this.#finalizePending(true));
      }
    }

    return emitted.map(cloneNode);
  }

  /**
   * Commits the unfinished tail as a left-aligned ragged row. Call this only
   * when the input stream is terminal; subsequent appends are still supported
   * but will begin a fresh row.
   */
  flushPending(): readonly JustifiedLayoutNode[] {
    return this.#finalizePending(false).map(cloneNode);
  }

  snapshot(): JustifiedLayoutResult {
    return {
      nodes: this.#nodes.map(cloneNode),
      totalHeight: this.totalHeight,
      rowCount: this.#rowCount,
      pendingCount: this.#pending.length,
    };
  }

  #finalizePending(justify: boolean): JustifiedLayoutNode[] {
    if (this.#pending.length === 0) {
      return [];
    }

    const items = this.#pending;
    const availableWidth =
      this.#config.viewport.width - this.#config.gap * (items.length - 1);
    const aspectRatioSum = items.reduce(
      (sum, item) => sum + item.width / item.height,
      0,
    );
    const fittedHeight = availableWidth / aspectRatioSum;
    const rowHeight = justify
      ? fittedHeight
      : Math.min(this.#config.targetRowHeight, fittedHeight);

    const rowIndex = this.#rowCount;
    let nextX = 0;
    const nodes = items.map((item) => {
      const width = rowHeight * (item.width / item.height);
      const node: JustifiedLayoutNode = {
        mediaId: item.mediaId,
        rowIndex,
        x: nextX,
        y: this.#nextY,
        width,
        height: rowHeight,
      };
      nextX += width + this.#config.gap;
      return node;
    });

    this.#nodes.push(...nodes);
    this.#pending = [];
    this.#rowCount += 1;
    this.#nextY += rowHeight + this.#config.gap;
    return nodes;
  }
}

export function layoutJustified(
  items: readonly MediaVisualInfo[],
  config: JustifiedLayoutConfig,
): JustifiedLayoutResult {
  const builder = new JustifiedLayoutBuilder(config);
  builder.append(items);
  builder.flushPending();
  return builder.snapshot();
}

function rowWidthAtTargetHeight(
  items: readonly MediaVisualInfo[],
  config: JustifiedLayoutConfig,
): number {
  if (items.length === 0) {
    return 0;
  }
  const mediaWidth = items.reduce(
    (sum, item) => sum + config.targetRowHeight * (item.width / item.height),
    0,
  );
  return mediaWidth + config.gap * (items.length - 1);
}

function validateConfig(config: JustifiedLayoutConfig): void {
  requireFinitePositive(config.viewport.width, "viewport.width");
  requireFiniteNonNegative(config.viewport.height, "viewport.height");
  requireFinitePositive(config.targetRowHeight, "targetRowHeight");
  requireFiniteNonNegative(config.gap, "gap");
}

function validateBatch(
  items: readonly MediaVisualInfo[],
  existingIds: ReadonlySet<string>,
): void {
  const batchIds = new Set<string>();
  for (const item of items) {
    if (item.mediaId.trim().length === 0) {
      throw new RangeError("mediaId must not be empty");
    }
    if (existingIds.has(item.mediaId) || batchIds.has(item.mediaId)) {
      throw new RangeError(`duplicate mediaId: ${item.mediaId}`);
    }
    requireFinitePositive(item.width, `width for ${item.mediaId}`);
    requireFinitePositive(item.height, `height for ${item.mediaId}`);
    batchIds.add(item.mediaId);
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

function cloneConfig(config: JustifiedLayoutConfig): JustifiedLayoutConfig {
  return {
    viewport: { ...config.viewport },
    targetRowHeight: config.targetRowHeight,
    gap: config.gap,
  };
}

function cloneVisual(item: MediaVisualInfo): MediaVisualInfo {
  return { ...item };
}

function cloneNode(node: JustifiedLayoutNode): JustifiedLayoutNode {
  return { ...node };
}
