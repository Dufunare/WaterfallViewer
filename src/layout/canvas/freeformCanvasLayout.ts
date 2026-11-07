import type { LayoutNode, MediaVisualInfo } from "../types";

export interface FreeformCanvasConfig {
  gap?: number;
  baseArea?: number;
  maxEdge?: number;
  blockWidth?: number;
  blockHeight?: number;
  cellSize?: number;
}

export interface FreeformCanvasNode extends LayoutNode {}
export interface FreeformCanvasBounds { x: number; y: number; width: number; height: number }
interface Rect { x: number; y: number; width: number; height: number }
interface PackingBlock { gridX: number; gridY: number; freeRects: Rect[] }
interface Placement { block: PackingBlock; x: number; y: number }
const ACTIVE_PACKING_BLOCKS = 8;

const DIRECTIONS = [
  { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 },
] as const;

/**
 * Append-stable, two-dimensional media atlas.
 *
 * Each bounded neighborhood uses MaxRects / best-short-side-fit to pack
 * mixed-aspect rectangles. Completed neighborhoods are positioned along a
 * square spiral, so scanning cannot turn the overall canvas into a single
 * unbounded row or column. Neighborhood boundaries are placement details,
 * not visible cards or grids. Previously placed images never move.
 *
 * A sparse grid indexes world coordinates for viewport queries; layout and
 * hit testing never need to enumerate every image during camera movement.
 */
export class FreeformCanvasLayoutBuilder {
  readonly #gap: number;
  readonly #baseArea: number;
  readonly #maxEdge: number;
  readonly #blockWidth: number;
  readonly #blockHeight: number;
  readonly #cellSize: number;
  readonly #nodes: FreeformCanvasNode[] = [];
  readonly #ids = new Set<string>();
  readonly #cells = new Map<string, number[]>();
  #bounds: FreeformCanvasBounds | null = null;
  readonly #activeBlocks: PackingBlock[];
  #blockX = 0;
  #blockY = 0;
  #directionIndex = 0;
  #directionSteps = 0;
  #legLength = 1;
  #completedLegs = 0;
  #blockCount = 1;

  constructor(config: FreeformCanvasConfig = {}) {
    this.#gap = nonNegative(config.gap ?? 4, "gap");
    this.#baseArea = positive(config.baseArea ?? 70_000, "baseArea");
    this.#maxEdge = positive(config.maxEdge ?? 720, "maxEdge");
    this.#blockWidth = positive(config.blockWidth ?? 1600, "blockWidth");
    this.#blockHeight = positive(config.blockHeight ?? 1280, "blockHeight");
    this.#cellSize = positive(config.cellSize ?? 512, "cellSize");
    if (this.#maxEdge + this.#gap > Math.min(this.#blockWidth, this.#blockHeight)) {
      throw new RangeError("maxEdge plus gap must fit within both block dimensions");
    }
    this.#activeBlocks = [{ gridX: 0, gridY: 0, freeRects: [this.#newFreeRect()] }];
  }

  get size(): number { return this.#nodes.length; }
  get firstNode(): FreeformCanvasNode | null {
    return this.#nodes.length === 0 ? null : { ...this.#nodes[0] };
  }
  get blockCount(): number { return this.#nodes.length === 0 ? 0 : this.#blockCount; }
  get bounds(): FreeformCanvasBounds {
    return this.#bounds === null ? { x: 0, y: 0, width: 0, height: 0 } : { ...this.#bounds };
  }

  append(items: readonly MediaVisualInfo[]): readonly FreeformCanvasNode[] {
    const batchIds = new Set<string>();
    for (const item of items) {
      if (!item.mediaId.trim() || this.#ids.has(item.mediaId) || batchIds.has(item.mediaId)) {
        throw new RangeError(`missing or duplicate mediaId: ${item.mediaId}`);
      }
      positive(item.width, `width for ${item.mediaId}`);
      positive(item.height, `height for ${item.mediaId}`);
      batchIds.add(item.mediaId);
    }

    const added: FreeformCanvasNode[] = [];
    for (const item of items) {
      const { width, height } = this.#sizeFor(item);
      let local = this.#findFit(width + this.#gap, height + this.#gap);
      if (local === null) {
        this.#advanceBlock();
        local = this.#findFit(width + this.#gap, height + this.#gap);
      }
      // Every item is guaranteed to fit in an empty neighborhood.
      if (local === null) throw new Error("image did not fit inside an empty canvas block");
      this.#occupy(local.block, { x: local.x, y: local.y, width: width + this.#gap, height: height + this.#gap });
      const node: FreeformCanvasNode = {
        mediaId: item.mediaId,
        x: local.block.gridX * (this.#blockWidth + this.#gap) + local.x,
        y: local.block.gridY * (this.#blockHeight + this.#gap) + local.y,
        width, height,
      };
      const index = this.#nodes.length;
      this.#nodes.push(node);
      this.#ids.add(node.mediaId);
      this.#indexNode(node, index);
      this.#extendBounds(node);
      added.push({ ...node });
    }
    return added;
  }

  /** Return only media whose rectangles intersect the world-space viewport. */
  query(rect: FreeformCanvasBounds): readonly FreeformCanvasNode[] {
    finite(rect.x, "rect.x");
    finite(rect.y, "rect.y");
    positive(rect.width, "rect.width");
    positive(rect.height, "rect.height");
    const seen = new Set<number>();
    this.#forEachCell(rect, (bucket) => {
      for (const index of bucket) seen.add(index);
    });
    return [...seen].sort((a, b) => a - b)
      .map((index) => this.#nodes[index])
      .filter((node) => intersects(node, rect))
      .map((node) => ({ ...node }));
  }

  /**
   * Early-exit visibility count used by zoom guards. Avoids sorting and cloning
   * hundreds of nodes for every wheel event.
   */
  count(rect: FreeformCanvasBounds, stopAt = Number.POSITIVE_INFINITY): number {
    finite(rect.x, "rect.x");
    finite(rect.y, "rect.y");
    positive(rect.width, "rect.width");
    positive(rect.height, "rect.height");
    if (!(stopAt > 0) || Number.isNaN(stopAt)) throw new RangeError("stopAt must be positive");
    const size = this.#cellSize;
    const minX = Math.floor(rect.x / size);
    const minY = Math.floor(rect.y / size);
    const maxX = Math.floor((rect.x + rect.width) / size);
    const maxY = Math.floor((rect.y + rect.height) / size);
    const seen = new Set<number>();
    let total = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const bucket = this.#cells.get(`${x}:${y}`);
        if (bucket === undefined) continue;
        for (const index of bucket) {
          if (seen.has(index)) continue;
          seen.add(index);
          if (intersects(this.#nodes[index], rect) && ++total >= stopAt) return total;
        }
      }
    }
    return total;
  }

  snapshot(): readonly FreeformCanvasNode[] { return this.#nodes.map((node) => ({ ...node })); }

  #sizeFor(item: MediaVisualInfo): { width: number; height: number } {
    // Cap only pathological panoramas; common photo aspect ratios are untouched.
    const ratio = Math.max(1 / 64, Math.min(64, item.width / item.height));
    const jitter = 0.88 + (stableHash(item.mediaId) % 301) / 1000;
    const area = this.#baseArea * jitter * jitter;
    const rawW = Math.sqrt(area * ratio);
    const rawH = Math.sqrt(area / ratio);
    const fit = Math.min(1, this.#maxEdge / Math.max(rawW, rawH));
    return {
      width: Math.max(1, Math.round(rawW * fit)),
      height: Math.max(1, Math.round(rawH * fit)),
    };
  }

  #findFit(width: number, height: number): Placement | null {
    let selected: Placement | null = null;
    let bestShort = Number.POSITIVE_INFINITY;
    let bestLong = Number.POSITIVE_INFINITY;
    // Keep a handful of recent neighborhoods available for back-filling.
    // This avoids losing large areas of useful free space at every spiral turn.
    for (const block of this.#activeBlocks) {
      for (const free of block.freeRects) {
        if (width > free.width || height > free.height) continue;
        const short = Math.min(free.width - width, free.height - height);
        const long = Math.max(free.width - width, free.height - height);
        if (short < bestShort || (short === bestShort && long < bestLong)) {
          selected = { block, x: free.x, y: free.y };
          bestShort = short;
          bestLong = long;
        }
      }
    }
    return selected;
  }

  #occupy(block: PackingBlock, used: Rect): void {
    const next: Rect[] = [];
    for (const free of block.freeRects) {
      if (!intersects(free, used)) {
        next.push(free);
        continue;
      }
      const freeRight = free.x + free.width;
      const freeBottom = free.y + free.height;
      const usedRight = used.x + used.width;
      const usedBottom = used.y + used.height;
      if (used.y > free.y && used.y < freeBottom) {
        next.push({ x: free.x, y: free.y, width: free.width, height: used.y - free.y });
      }
      if (usedBottom < freeBottom) {
        next.push({ x: free.x, y: usedBottom, width: free.width, height: freeBottom - usedBottom });
      }
      if (used.x > free.x && used.x < freeRight) {
        next.push({ x: free.x, y: free.y, width: used.x - free.x, height: free.height });
      }
      if (usedRight < freeRight) {
        next.push({ x: usedRight, y: free.y, width: freeRight - usedRight, height: free.height });
      }
    }
    // MaxRects free regions may overlap each other, never occupied images.
    block.freeRects = next.filter((candidate, index) => !next.some((other, otherIndex) =>
      index !== otherIndex && contains(other, candidate) &&
      (!sameRect(other, candidate) || otherIndex < index),
    ));
  }

  #newFreeRect(): Rect {
    return { x: 0, y: 0, width: this.#blockWidth, height: this.#blockHeight };
  }

  #advanceBlock(): void {
    const direction = DIRECTIONS[this.#directionIndex];
    this.#blockX += direction.x;
    this.#blockY += direction.y;
    this.#directionSteps++;
    if (this.#directionSteps === this.#legLength) {
      this.#directionSteps = 0;
      this.#directionIndex = (this.#directionIndex + 1) % DIRECTIONS.length;
      this.#completedLegs++;
      if (this.#completedLegs === 2) {
        this.#completedLegs = 0;
        this.#legLength++;
      }
    }
    this.#blockCount++;
    this.#activeBlocks.push({ gridX: this.#blockX, gridY: this.#blockY, freeRects: [this.#newFreeRect()] });
    if (this.#activeBlocks.length > ACTIVE_PACKING_BLOCKS) this.#activeBlocks.shift();
  }

  #indexNode(node: FreeformCanvasNode, index: number): void {
    this.#forCellCoordinates(node, (key) => {
      let bucket = this.#cells.get(key);
      if (bucket === undefined) {
        bucket = [];
        this.#cells.set(key, bucket);
      }
      bucket.push(index);
    });
  }

  #forEachCell(rect: Rect, callback: (bucket: number[]) => void): void {
    this.#forCellCoordinates(rect, (key) => {
      const bucket = this.#cells.get(key);
      if (bucket !== undefined) callback(bucket);
    });
  }

  #forCellCoordinates(rect: Rect, callback: (key: string) => void): void {
    const size = this.#cellSize;
    const minX = Math.floor(rect.x / size);
    const minY = Math.floor(rect.y / size);
    const maxX = Math.floor((rect.x + rect.width) / size);
    const maxY = Math.floor((rect.y + rect.height) / size);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) callback(`${x}:${y}`);
    }
  }

  #extendBounds(node: FreeformCanvasNode): void {
    const b = this.#bounds;
    if (b === null) {
      this.#bounds = { x: node.x, y: node.y, width: node.width, height: node.height };
      return;
    }
    const left = Math.min(b.x, node.x);
    const top = Math.min(b.y, node.y);
    this.#bounds = {
      x: left, y: top,
      width: Math.max(b.x + b.width, node.x + node.width) - left,
      height: Math.max(b.y + b.height, node.y + node.height) - top,
    };
  }
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
}
function contains(a: Rect, b: Rect): boolean {
  return a.x <= b.x && a.y <= b.y &&
    a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
}
function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
function stableHash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}
function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}
function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
  return value;
}
function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative and finite`);
  return value;
}
