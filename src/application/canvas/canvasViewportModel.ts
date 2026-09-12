import {
  Camera2D,
  type Camera2DOptions,
  type Camera2DSnapshot,
  type Point2D,
  type Rect2D,
  type Size2D,
} from "../../layout/canvas/camera2d";
import type { LayoutNode } from "../../layout/types";
import { UniformGridSpatialIndex } from "../../layout/spatial/uniformGridSpatialIndex";

export type CanvasLod = "placeholder" | "thumbnail" | "detail";

export interface CanvasVisibleNode<TNode extends LayoutNode = LayoutNode> {
  node: TNode;
  screenRect: Rect2D;
  lod: CanvasLod;
}

export interface CanvasViewportOptions {
  camera?: Camera2DOptions;
  cellSize?: number;
  overscanPx?: number;
  thumbnailMinEdgePx?: number;
  detailMinEdgePx?: number;
}

interface ResolvedCanvasViewportOptions {
  overscanPx: number;
  thumbnailMinEdgePx: number;
  detailMinEdgePx: number;
}

const DEFAULT_OPTIONS: ResolvedCanvasViewportOptions = {
  overscanPx: 256,
  thumbnailMinEdgePx: 48,
  detailMinEdgePx: 768,
};

/**
 * Headless free-canvas viewport model.
 *
 * Geometry lives in world coordinates. The model owns camera transforms,
 * spatial visibility queries, overscan expansion, coarse LOD selection, and
 * point hit testing; renderers receive only projected results.
 */
export class CanvasViewportModel<TNode extends LayoutNode = LayoutNode> {
  readonly #camera: Camera2D;
  readonly #index: UniformGridSpatialIndex<TNode>;
  readonly #options: ResolvedCanvasViewportOptions;

  constructor(options: CanvasViewportOptions = {}) {
    this.#camera = new Camera2D(options.camera);
    this.#index = new UniformGridSpatialIndex<TNode>(options.cellSize ?? 512);
    this.#options = resolveOptions(options);
  }

  get nodeCount(): number {
    return this.#index.size;
  }

  get cameraSnapshot(): Camera2DSnapshot {
    return this.#camera.snapshot();
  }

  setViewport(viewport: Size2D): void {
    this.#camera.setViewport(viewport);
  }

  setCenter(center: Point2D): void {
    this.#camera.setCenter(center);
  }

  panByScreen(delta: Point2D): void {
    this.#camera.panByScreen(delta);
  }

  zoomAtScreen(zoom: number, anchor: Point2D): void {
    this.#camera.zoomAtScreen(zoom, anchor);
  }

  zoomByFactorAtScreen(factor: number, anchor: Point2D): void {
    this.#camera.zoomByFactorAtScreen(factor, anchor);
  }

  upsertNodes(nodes: readonly TNode[]): void {
    this.#index.upsertMany(nodes);
  }

  removeNode(mediaId: string): boolean {
    return this.#index.remove(mediaId);
  }

  clearNodes(): void {
    this.#index.clear();
  }

  queryVisible(overscanPx = this.#options.overscanPx): readonly CanvasVisibleNode<TNode>[] {
    requireFiniteNonNegative(overscanPx, "overscanPx");
    const worldRect = this.#camera.visibleWorldRect(overscanPx);
    return this.#index.query(worldRect).map((node) => {
      const screenRect = this.#camera.worldRectToScreen(node);
      return {
        node,
        screenRect,
        lod: selectLod(screenRect, this.#options),
      };
    });
  }

  hitTestScreen(point: Point2D): TNode | null {
    requireFinite(point.x, "point.x");
    requireFinite(point.y, "point.y");
    const world = this.#camera.screenToWorld(point);
    const worldPixel = 1 / this.#camera.zoom;
    const candidates = this.#index.query({
      x: world.x - worldPixel / 2,
      y: world.y - worldPixel / 2,
      width: worldPixel,
      height: worldPixel,
    });

    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const node = candidates[index];
      if (
        world.x >= node.x &&
        world.x <= node.x + node.width &&
        world.y >= node.y &&
        world.y <= node.y + node.height
      ) {
        return { ...node };
      }
    }
    return null;
  }
}

function selectLod(
  screenRect: Rect2D,
  options: ResolvedCanvasViewportOptions,
): CanvasLod {
  const projectedMaxEdge = Math.max(screenRect.width, screenRect.height);
  if (projectedMaxEdge < options.thumbnailMinEdgePx) {
    return "placeholder";
  }
  if (projectedMaxEdge >= options.detailMinEdgePx) {
    return "detail";
  }
  return "thumbnail";
}

function resolveOptions(
  options: CanvasViewportOptions,
): ResolvedCanvasViewportOptions {
  const resolved = {
    overscanPx: options.overscanPx ?? DEFAULT_OPTIONS.overscanPx,
    thumbnailMinEdgePx:
      options.thumbnailMinEdgePx ?? DEFAULT_OPTIONS.thumbnailMinEdgePx,
    detailMinEdgePx:
      options.detailMinEdgePx ?? DEFAULT_OPTIONS.detailMinEdgePx,
  };

  requireFiniteNonNegative(resolved.overscanPx, "overscanPx");
  requireFinitePositive(resolved.thumbnailMinEdgePx, "thumbnailMinEdgePx");
  requireFinitePositive(resolved.detailMinEdgePx, "detailMinEdgePx");
  if (resolved.detailMinEdgePx < resolved.thumbnailMinEdgePx) {
    throw new RangeError(
      "detailMinEdgePx must be greater than or equal to thumbnailMinEdgePx",
    );
  }
  return resolved;
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
