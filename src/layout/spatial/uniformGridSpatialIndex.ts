import type { LayoutNode } from "../types";

export interface SpatialQueryRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface IndexedNode<TNode extends LayoutNode> {
  node: TNode;
  sequence: number;
  cells: readonly string[];
}

/**
 * Mutable 2D broad-phase index for free-canvas nodes.
 *
 * A node may occupy several grid cells. Queries deduplicate candidates and do
 * an exact AABB intersection before returning nodes in stable insertion order.
 */
export class UniformGridSpatialIndex<TNode extends LayoutNode = LayoutNode> {
  readonly #cellSize: number;
  readonly #entries = new Map<string, IndexedNode<TNode>>();
  readonly #cells = new Map<string, Set<string>>();
  #nextSequence = 0;

  constructor(cellSize = 512) {
    requireFinitePositive(cellSize, "cellSize");
    this.#cellSize = cellSize;
  }

  get size(): number {
    return this.#entries.size;
  }

  get cellSize(): number {
    return this.#cellSize;
  }

  upsertMany(nodes: readonly TNode[]): void {
    validateBatch(nodes);

    for (const node of nodes) {
      const existing = this.#entries.get(node.mediaId);
      if (existing !== undefined) {
        this.#detach(existing);
      }

      const cells = cellKeysForRect(node, this.#cellSize);
      const entry: IndexedNode<TNode> = {
        node: cloneNode(node),
        sequence: existing?.sequence ?? this.#nextSequence++,
        cells,
      };
      this.#entries.set(node.mediaId, entry);
      for (const key of cells) {
        let bucket = this.#cells.get(key);
        if (bucket === undefined) {
          bucket = new Set<string>();
          this.#cells.set(key, bucket);
        }
        bucket.add(node.mediaId);
      }
    }
  }

  remove(mediaId: string): boolean {
    const entry = this.#entries.get(mediaId);
    if (entry === undefined) {
      return false;
    }
    this.#detach(entry);
    this.#entries.delete(mediaId);
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#cells.clear();
    this.#nextSequence = 0;
  }

  get(mediaId: string): TNode | undefined {
    const entry = this.#entries.get(mediaId);
    return entry === undefined ? undefined : cloneNode(entry.node);
  }

  query(rect: SpatialQueryRect): readonly TNode[] {
    validateRect(rect, "query");
    const candidateIds = new Set<string>();
    for (const key of cellKeysForRect(rect, this.#cellSize)) {
      const bucket = this.#cells.get(key);
      if (bucket === undefined) {
        continue;
      }
      for (const mediaId of bucket) {
        candidateIds.add(mediaId);
      }
    }

    return [...candidateIds]
      .map((mediaId) => this.#entries.get(mediaId))
      .filter((entry): entry is IndexedNode<TNode> => entry !== undefined)
      .filter((entry) => intersects(entry.node, rect))
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => cloneNode(entry.node));
  }

  snapshot(): readonly TNode[] {
    return [...this.#entries.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => cloneNode(entry.node));
  }

  #detach(entry: IndexedNode<TNode>): void {
    for (const key of entry.cells) {
      const bucket = this.#cells.get(key);
      if (bucket === undefined) {
        continue;
      }
      bucket.delete(entry.node.mediaId);
      if (bucket.size === 0) {
        this.#cells.delete(key);
      }
    }
  }
}

function cellKeysForRect(rect: SpatialQueryRect, cellSize: number): string[] {
  const left = Math.floor(rect.x / cellSize);
  const top = Math.floor(rect.y / cellSize);
  const right = Math.floor((rect.x + rect.width) / cellSize);
  const bottom = Math.floor((rect.y + rect.height) / cellSize);
  const keys: string[] = [];

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      keys.push(`${x}:${y}`);
    }
  }
  return keys;
}

function intersects(left: SpatialQueryRect, right: SpatialQueryRect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function validateBatch<TNode extends LayoutNode>(nodes: readonly TNode[]): void {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.mediaId.trim().length === 0) {
      throw new RangeError("mediaId must not be empty");
    }
    if (ids.has(node.mediaId)) {
      throw new RangeError(`duplicate mediaId in batch: ${node.mediaId}`);
    }
    validateRect(node, `node ${node.mediaId}`);
    ids.add(node.mediaId);
  }
}

function validateRect(rect: SpatialQueryRect, name: string): void {
  requireFinite(rect.x, `${name}.x`);
  requireFinite(rect.y, `${name}.y`);
  requireFinitePositive(rect.width, `${name}.width`);
  requireFinitePositive(rect.height, `${name}.height`);
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

function cloneNode<TNode extends LayoutNode>(node: TNode): TNode {
  return { ...node };
}
