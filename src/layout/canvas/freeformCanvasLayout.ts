import type { LayoutNode, MediaVisualInfo } from "../types";

export interface FreeformCanvasConfig {
  gap?: number;
  baseArea?: number;
  maxEdge?: number;
  blockWidth?: number;
  blockHeight?: number;
  /** Preferred outer aspect ratio; replaces hard block boundaries. */
  targetAspect?: number;
  cellSize?: number;
}

export interface FreeformCanvasNode extends LayoutNode {}
export interface FreeformCanvasBounds { x: number; y: number; width: number; height: number }
interface Rect { x: number; y: number; width: number; height: number }
interface PlacedSize { width: number; height: number }
interface Fit {
  index: number;
  scale: number;
  paddedWidth: number;
  paddedHeight: number;
  score: number;
}

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
/**
 * Online, continuous guillotine packing with elastic media sizes.
 *
 * The atlas maintains a *single growable rectangular domain*, not a spiral of
 * independent fixed-size blocks. A disjoint free-rectangle list covers holes
 * within that domain. An image is fitted into the most promising hole (within
 * a moderate scale range), and that hole is split into two disjoint pieces.
 *
 * When no existing hole accommodates the next media, the domain grows along
 * its shorter dimension. New strips are split and remain usable by subsequent
 * media. Expansions alternate left/right or up/down around the first image
 * instead of creating a row-shaped layout. Previously placed nodes never move.
 *
 * This avoids the broad empty seams at the boundaries of fixed packing blocks
 * while retaining deterministic append-only placement and O(visible) queries.
 */
export class FreeformCanvasLayoutBuilder {
  readonly #gap: number;
  readonly #baseArea: number;
  readonly #maxEdge: number;
  readonly #targetAspect: number;
  readonly #cellSize: number;
  readonly #nodes: FreeformCanvasNode[] = [];
  readonly #ids = new Set<string>();
  readonly #cells = new Map<string, number[]>();
  readonly #freeRects: Rect[] = [];
  #bounds: FreeformCanvasBounds | null = null;
  #domain: Rect | null = null;
  #growthCount = 0;
  
  constructor(config: FreeformCanvasConfig = {}) {
    this.#gap = nonNegative(config.gap ?? 4, "gap");
    this.#baseArea = positive(config.baseArea ?? 70_000, "baseArea");
    this.#maxEdge = positive(config.maxEdge ?? 720, "maxEdge");
    this.#cellSize = positive(config.cellSize ?? 512, "cellSize");
    // Old block dimensions become a preferred global shape, not hard walls.
    this.#targetAspect = positive(config.targetAspect ??
      (positive(config.blockWidth ?? 1600, "blockWidth") /
       positive(config.blockHeight ?? 1280, "blockHeight")), "targetAspect");
  }

  get size(): number { return this.#nodes.length; }
  get firstNode(): FreeformCanvasNode | null {
    return this.#nodes.length === 0 ? null : { ...this.#nodes[0] };
  }
  /** Backwards-compatible diagnostic: number of allocated growth regions. */
  get blockCount(): number { return this.#domain === null ? 0 : this.#growthCount + 1; }
  get bounds(): FreeformCanvasBounds {
    return this.#bounds === null ? { x: 0, y: 0, width: 0, height: 0 } : { ...this.#bounds };
  }

  append(items: readonly MediaVisualInfo[]): readonly FreeformCanvasNode[] {
    const batchIds = new Set<string>();
    // Validate the entire batch before changing layout or index state.
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
      const natural = this.#sizeFor(item);
      const fit = this.#bestFit(natural);
      let x: number;
      let y: number;
      let width: number;
      let height: number;
      if (this.#domain === null) {
        width = natural.width;
        height = natural.height;
        x = -Math.round(width / 2);
        y = -Math.round(height / 2);
        this.#domain = { x, y, width: width + this.#gap, height: height + this.#gap };
      } else if (fit !== null) {
        const free = this.#freeRects[fit.index];
        x = free.x;
        y = free.y;
        width = Math.max(1, Math.round(natural.width * fit.scale));
        height = Math.max(1, Math.round(natural.height * fit.scale));
        this.#splitFreeRect(fit.index, width + this.#gap, height + this.#gap);
      } else {
        width = natural.width;
        height = natural.height;
        ({ x, y } = this.#growAndPlace(width + this.#gap, height + this.#gap));
      }
      const node: FreeformCanvasNode = { mediaId: item.mediaId, x, y, width, height };
      const index = this.#nodes.length;
      this.#nodes.push(node);
      this.#ids.add(node.mediaId);
      this.#indexNode(node, index);
      this.#extendBounds(node);
      added.push({ ...node });
    }
    return added;
  }

  query(rect: FreeformCanvasBounds): readonly FreeformCanvasNode[] {
    validateQuery(rect);
    const seen = new Set<number>();
    this.#forEachCell(rect, (bucket) => {
      for (const index of bucket) seen.add(index);
    });
    return [...seen].sort((a, b) => a - b)
      .map((index) => this.#nodes[index])
      .filter((node) => intersects(node, rect))
      .map((node) => ({ ...node }));
  }

  /** Early-exit count for zoom bounds; no sort, cloning or full node scan. */
  count(rect: FreeformCanvasBounds, stopAt = Number.POSITIVE_INFINITY): number {
    validateQuery(rect);
    if (!(stopAt > 0) || Number.isNaN(stopAt)) {
      throw new RangeError("stopAt must be positive");
    }
    const seen = new Set<number>();
    let total = 0;
    const cellSize = this.#cellSize;
    const minX = Math.floor(rect.x / cellSize);
    const minY = Math.floor(rect.y / cellSize);
    const maxX = Math.floor((rect.x + rect.width) / cellSize);
    const maxY = Math.floor((rect.y + rect.height) / cellSize);
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

  snapshot(): readonly FreeformCanvasNode[] {
    return this.#nodes.map((node) => ({ ...node }));
  }

  #sizeFor(item: MediaVisualInfo): PlacedSize {
    // Preserve the aspect ratio. Only pathological panoramas are capped;
    // deterministic jitter avoids visually uniform tile sizes.
    const aspect = Math.max(1 / 64, Math.min(64, item.width / item.height));
    const jitter = 0.88 + (stableHash(item.mediaId) % 301) / 1000;
    const area = this.#baseArea * jitter * jitter;
    const rawWidth = Math.sqrt(area * aspect);
    const rawHeight = Math.sqrt(area / aspect);
    const fit = Math.min(1, this.#maxEdge / Math.max(rawWidth, rawHeight));
    return {
      width: Math.max(1, Math.round(rawWidth * fit)),
      height: Math.max(1, Math.round(rawHeight * fit)),
    };
  }

  #bestFit(natural: PlacedSize): Fit | null {
    const MIN_SCALE = 0.64;
    const MAX_SCALE = 1.28;
    let selected: Fit | null = null;
    for (let index = 0; index < this.#freeRects.length; index++) {
      const free = this.#freeRects[index];
      const maxScale = Math.min(
        MAX_SCALE,
        this.#maxEdge / Math.max(natural.width, natural.height),
        (free.width - this.#gap) / natural.width,
        (free.height - this.#gap) / natural.height,
      );
      if (maxScale < MIN_SCALE) continue;
      // Keep individual media roughly the same size, while scaling a photo up
      // or down when that removes an otherwise wasted rectangular strip.
      let scale = Math.min(1.15, maxScale);
      if (maxScale > scale) {
        const freeShortSide = Math.min(
          free.width - (Math.round(natural.width * scale) + this.#gap),
          free.height - (Math.round(natural.height * scale) + this.#gap),
        );
        if (freeShortSide > 0 && freeShortSide < 32) scale = maxScale;
      }
      const paddedWidth = Math.round(natural.width * scale) + this.#gap;
      const paddedHeight = Math.round(natural.height * scale) + this.#gap;
      if (paddedWidth > free.width || paddedHeight > free.height) continue;
      const shortRemaining = Math.min(free.width - paddedWidth, free.height - paddedHeight);
      const longRemaining = Math.max(free.width - paddedWidth, free.height - paddedHeight);
      const sliverPenalty = shortRemaining > 0 && shortRemaining < 36 ? 90 : 0;
      const score = shortRemaining * 0.5 + longRemaining * 0.05 +
        Math.abs(Math.log(scale)) * 100 + sliverPenalty;
      if (selected === null || score < selected.score) {
        selected = { index, scale, paddedWidth, paddedHeight, score };
      }
    }
    return selected;
  }

  #splitFreeRect(index: number, usedWidth: number, usedHeight: number): void {
    const free = this.#freeRects[index];
    this.#freeRects.splice(index, 1);
    const remainingWidth = free.width - usedWidth;
    const remainingHeight = free.height - usedHeight;
    const rightFull: Rect = {
      x: free.x + usedWidth, y: free.y,
      width: remainingWidth, height: free.height,
    };
    const bottomNarrow: Rect = {
      x: free.x, y: free.y + usedHeight,
      width: usedWidth, height: remainingHeight,
    };
    const rightNarrow: Rect = {
      x: free.x + usedWidth, y: free.y,
      width: remainingWidth, height: usedHeight,
    };
    const bottomFull: Rect = {
      x: free.x, y: free.y + usedHeight,
      width: free.width, height: remainingHeight,
    };
    // A guillotine split never creates overlapping free rectangles.
    // Prefer the partition which leaves fewer unusably skinny strips.
    const discarded = (rects: readonly Rect[]): number =>
      rects.reduce((waste, r) => waste +
        (r.width < 130 || r.height < 130 ? r.width * r.height : 0), 0);
    const horizontal = discarded([rightNarrow, bottomFull]) <
      discarded([rightFull, bottomNarrow]);
    const pair = horizontal
      ? [rightNarrow, bottomFull]
      : [rightFull, bottomNarrow];
    for (const rect of pair) {
      // Very small slivers can never host a readable photo.
      if (rect.width > 20 && rect.height > 20) this.#freeRects.push(rect);
    }
  }

  #growAndPlace(paddedWidth: number, paddedHeight: number): Point {
    const domain = this.#domain;
    if (domain === null) throw new Error("canvas growth requires a domain");
    const rightRatio = (domain.width + paddedWidth) / Math.max(domain.height, paddedHeight);
    const bottomRatio = Math.max(domain.width, paddedWidth) / (domain.height + paddedHeight);
    const growHorizontal =
      Math.abs(Math.log(rightRatio / this.#targetAspect)) <=
      Math.abs(Math.log(bottomRatio / this.#targetAspect));

    let x: number;
    let y: number;
    if (growHorizontal) {
      const growLeft = domain.x + domain.width > -domain.x;
      x = growLeft ? domain.x - paddedWidth : domain.x + domain.width;
      y = domain.y;
      const height = Math.max(domain.height, paddedHeight);
      const extra = height - domain.height;
      if (extra > 0) {
        this.#freeRects.push({
          x: domain.x, y: domain.y + domain.height,
          width: domain.width, height: extra,
        });
      }
      this.#freeRects.push({ x, y, width: paddedWidth, height });
      this.#domain = {
        x: growLeft ? x : domain.x,
        y: domain.y,
        width: domain.width + paddedWidth,
        height,
      };
    } else {
      const growUp = domain.y + domain.height > -domain.y;
      x = domain.x;
      y = growUp ? domain.y - paddedHeight : domain.y + domain.height;
      const width = Math.max(domain.width, paddedWidth);
      const extra = width - domain.width;
      if (extra > 0) {
        this.#freeRects.push({
          x: domain.x + domain.width, y: domain.y,
          width: extra, height: domain.height,
        });
      }
      this.#freeRects.push({ x, y, width, height: paddedHeight });
      this.#domain = {
        x: domain.x,
        y: growUp ? y : domain.y,
        width, height: domain.height + paddedHeight,
      };
    }
    // Consume from the newly introduced strip. The remainder is reusable,
    // so growth never permanently reserves a blank rectangular "block".
    this.#splitFreeRect(this.#freeRects.length - 1, paddedWidth, paddedHeight);
    this.#growthCount++;
    return { x, y };
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

interface Point { x: number; y: number }

function validateQuery(rect: FreeformCanvasBounds): void {
  finite(rect.x, "rect.x");
  finite(rect.y, "rect.y");
  positive(rect.width, "rect.width");
  positive(rect.height, "rect.height");
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
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
