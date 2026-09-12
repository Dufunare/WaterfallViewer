import type {
  LayoutNode,
  MediaVisualInfo,
  ViewportSize,
} from "../types";

export type { MediaVisualInfo, ViewportSize } from "../types";

export interface MasonryLayoutConfig {
  viewport: ViewportSize;
  columnCount: number;
  gap: number;
}

export interface MasonryLayoutNode extends LayoutNode {
  columnIndex: number;
}

export interface MasonryLayoutResult {
  nodes: readonly MasonryLayoutNode[];
  totalHeight: number;
  columnWidth: number;
}

/**
 * Stateful only for incremental computation. Given the same config and item
 * order, appending batches produces the same geometry as a one-shot layout.
 */
export class MasonryLayoutBuilder {
  readonly #config: MasonryLayoutConfig;
  readonly #columnWidth: number;
  readonly #nextY: number[];
  readonly #nodes: MasonryLayoutNode[] = [];
  readonly #mediaIds = new Set<string>();

  constructor(config: MasonryLayoutConfig) {
    validateConfig(config);
    this.#config = cloneConfig(config);
    this.#columnWidth = calculateColumnWidth(config);
    this.#nextY = Array.from({ length: config.columnCount }, () => 0);
  }

  get size(): number {
    return this.#nodes.length;
  }

  get columnWidth(): number {
    return this.#columnWidth;
  }

  get totalHeight(): number {
    if (this.#nodes.length === 0) {
      return 0;
    }

    return Math.max(...this.#nextY) - this.#config.gap;
  }

  /**
   * Append a batch atomically. Invalid or duplicate entries reject the entire
   * batch without mutating existing layout state.
   */
  append(items: readonly MediaVisualInfo[]): readonly MasonryLayoutNode[] {
    validateBatch(items, this.#mediaIds);

    const added: MasonryLayoutNode[] = [];
    for (const item of items) {
      const columnIndex = shortestColumnIndex(this.#nextY);
      const x = columnIndex * (this.#columnWidth + this.#config.gap);
      const y = this.#nextY[columnIndex];
      const height = (this.#columnWidth * item.height) / item.width;
      const node: MasonryLayoutNode = {
        mediaId: item.mediaId,
        columnIndex,
        x,
        y,
        width: this.#columnWidth,
        height,
      };

      this.#nodes.push(node);
      this.#mediaIds.add(item.mediaId);
      added.push(node);
      this.#nextY[columnIndex] = y + height + this.#config.gap;
    }

    return added.map(cloneNode);
  }

  snapshot(): MasonryLayoutResult {
    return {
      nodes: this.#nodes.map(cloneNode),
      totalHeight: this.totalHeight,
      columnWidth: this.#columnWidth,
    };
  }
}

export function layoutMasonry(
  items: readonly MediaVisualInfo[],
  config: MasonryLayoutConfig,
): MasonryLayoutResult {
  const builder = new MasonryLayoutBuilder(config);
  builder.append(items);
  return builder.snapshot();
}

function calculateColumnWidth(config: MasonryLayoutConfig): number {
  return (
    (config.viewport.width - config.gap * (config.columnCount - 1)) /
    config.columnCount
  );
}

function shortestColumnIndex(columnHeights: readonly number[]): number {
  let shortestIndex = 0;
  let shortestHeight = columnHeights[0];

  for (let index = 1; index < columnHeights.length; index += 1) {
    if (columnHeights[index] < shortestHeight) {
      shortestIndex = index;
      shortestHeight = columnHeights[index];
    }
  }

  return shortestIndex;
}

function validateConfig(config: MasonryLayoutConfig): void {
  requireFinitePositive(config.viewport.width, "viewport.width");
  requireFiniteNonNegative(config.viewport.height, "viewport.height");
  requireFiniteNonNegative(config.gap, "gap");

  if (!Number.isInteger(config.columnCount) || config.columnCount <= 0) {
    throw new RangeError("columnCount must be a positive integer");
  }

  if (calculateColumnWidth(config) <= 0) {
    throw new RangeError("viewport width must leave positive space for every column");
  }
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

function cloneConfig(config: MasonryLayoutConfig): MasonryLayoutConfig {
  return {
    viewport: { ...config.viewport },
    columnCount: config.columnCount,
    gap: config.gap,
  };
}

function cloneNode(node: MasonryLayoutNode): MasonryLayoutNode {
  return { ...node };
}
