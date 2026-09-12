import type { LayoutNode, MediaVisualInfo } from "../types";

export interface CanvasAtlasConfig {
  worldWidth: number;
  itemHeight: number;
  gap: number;
  minItemWidth?: number;
}

export interface CanvasAtlasNode extends LayoutNode {
  rowIndex: number;
}

export interface CanvasAtlasBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasAtlasSnapshot {
  nodes: readonly CanvasAtlasNode[];
  rowCount: number;
  bounds: CanvasAtlasBounds;
}

interface ResolvedCanvasAtlasConfig {
  worldWidth: number;
  itemHeight: number;
  gap: number;
  minItemWidth: number;
}

/**
 * Stable append-only initial placement for free-canvas media.
 *
 * The atlas is not a viewport layout: it only assigns deterministic world
 * coordinates. Existing nodes never move when new media arrives, which makes
 * streaming scans friendly to the 2D spatial index and GPU scene graph.
 */
export class CanvasAtlasLayoutBuilder {
  readonly #config: ResolvedCanvasAtlasConfig;
  readonly #nodes: CanvasAtlasNode[] = [];
  readonly #mediaIds = new Set<string>();
  #nextX = 0;
  #nextY = 0;
  #rowIndex = 0;
  #rowHasItems = false;
  #maxRight = 0;
  #maxBottom = 0;

  constructor(config: CanvasAtlasConfig) {
    this.#config = resolveConfig(config);
  }

  get size(): number {
    return this.#nodes.length;
  }

  get rowCount(): number {
    return this.#nodes.length === 0 ? 0 : this.#rowIndex + 1;
  }

  get bounds(): CanvasAtlasBounds {
    return {
      x: 0,
      y: 0,
      width: this.#maxRight,
      height: this.#maxBottom,
    };
  }

  append(items: readonly MediaVisualInfo[]): readonly CanvasAtlasNode[] {
    validateBatch(items, this.#mediaIds);
    const added: CanvasAtlasNode[] = [];

    for (const item of items) {
      const aspectRatio = item.width / item.height;
      const width = Math.min(
        this.#config.worldWidth,
        Math.max(this.#config.minItemWidth, this.#config.itemHeight * aspectRatio),
      );

      if (
        this.#rowHasItems &&
        this.#nextX + width > this.#config.worldWidth
      ) {
        this.#rowIndex += 1;
        this.#nextX = 0;
        this.#nextY += this.#config.itemHeight + this.#config.gap;
        this.#rowHasItems = false;
      }

      const node: CanvasAtlasNode = {
        mediaId: item.mediaId,
        rowIndex: this.#rowIndex,
        x: this.#nextX,
        y: this.#nextY,
        width,
        height: this.#config.itemHeight,
      };
      this.#nodes.push(node);
      this.#mediaIds.add(item.mediaId);
      added.push(node);
      this.#rowHasItems = true;
      this.#nextX += width + this.#config.gap;
      this.#maxRight = Math.max(this.#maxRight, node.x + node.width);
      this.#maxBottom = Math.max(this.#maxBottom, node.y + node.height);
    }

    return added.map(cloneNode);
  }

  snapshot(): CanvasAtlasSnapshot {
    return {
      nodes: this.#nodes.map(cloneNode),
      rowCount: this.rowCount,
      bounds: this.bounds,
    };
  }
}

export function layoutCanvasAtlas(
  items: readonly MediaVisualInfo[],
  config: CanvasAtlasConfig,
): CanvasAtlasSnapshot {
  const builder = new CanvasAtlasLayoutBuilder(config);
  builder.append(items);
  return builder.snapshot();
}

function resolveConfig(config: CanvasAtlasConfig): ResolvedCanvasAtlasConfig {
  requireFinitePositive(config.worldWidth, "worldWidth");
  requireFinitePositive(config.itemHeight, "itemHeight");
  requireFiniteNonNegative(config.gap, "gap");
  const minItemWidth = config.minItemWidth ?? config.itemHeight * 0.25;
  requireFinitePositive(minItemWidth, "minItemWidth");
  if (minItemWidth > config.worldWidth) {
    throw new RangeError("minItemWidth must not exceed worldWidth");
  }
  return {
    worldWidth: config.worldWidth,
    itemHeight: config.itemHeight,
    gap: config.gap,
    minItemWidth,
  };
}

function validateBatch(
  items: readonly MediaVisualInfo[],
  existingIds: ReadonlySet<string>,
): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.mediaId.trim().length === 0) {
      throw new RangeError("mediaId must not be empty");
    }
    if (existingIds.has(item.mediaId) || ids.has(item.mediaId)) {
      throw new RangeError(`duplicate mediaId: ${item.mediaId}`);
    }
    requireFinitePositive(item.width, `width for ${item.mediaId}`);
    requireFinitePositive(item.height, `height for ${item.mediaId}`);
    ids.add(item.mediaId);
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

function cloneNode(node: CanvasAtlasNode): CanvasAtlasNode {
  return { ...node };
}
