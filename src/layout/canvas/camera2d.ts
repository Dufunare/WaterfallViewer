export interface Point2D {
  x: number;
  y: number;
}

export interface Size2D {
  width: number;
  height: number;
}

export interface Rect2D extends Point2D, Size2D {}

export interface Camera2DOptions {
  center?: Point2D;
  zoom?: number;
  minZoom?: number;
  maxZoom?: number;
  viewport?: Size2D;
}

export interface Camera2DSnapshot {
  center: Point2D;
  zoom: number;
  minZoom: number;
  maxZoom: number;
  viewport: Size2D;
}

const DEFAULT_MIN_ZOOM = 0.05;
const DEFAULT_MAX_ZOOM = 32;

/**
 * Renderer-agnostic camera for the free-canvas view.
 *
 * The camera stores the world coordinate located at the viewport center. It
 * intentionally has no DOM, pointer-event, Pixi, or platform dependencies.
 */
export class Camera2D {
  #center: Point2D;
  #zoom: number;
  readonly #minZoom: number;
  readonly #maxZoom: number;
  #viewport: Size2D;

  constructor(options: Camera2DOptions = {}) {
    const minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM;
    const maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM;
    requireFinitePositive(minZoom, "minZoom");
    requireFinitePositive(maxZoom, "maxZoom");
    if (maxZoom < minZoom) {
      throw new RangeError("maxZoom must be greater than or equal to minZoom");
    }

    const center = options.center ?? { x: 0, y: 0 };
    requireFinite(center.x, "center.x");
    requireFinite(center.y, "center.y");

    const viewport = options.viewport ?? { width: 1, height: 1 };
    validateViewport(viewport);

    this.#minZoom = minZoom;
    this.#maxZoom = maxZoom;
    this.#zoom = clampZoom(options.zoom ?? 1, minZoom, maxZoom);
    this.#center = { ...center };
    this.#viewport = { ...viewport };
  }

  get zoom(): number {
    return this.#zoom;
  }

  get center(): Point2D {
    return { ...this.#center };
  }

  get viewport(): Size2D {
    return { ...this.#viewport };
  }

  setViewport(viewport: Size2D): void {
    validateViewport(viewport);
    this.#viewport = { ...viewport };
  }

  setCenter(center: Point2D): void {
    requireFinite(center.x, "center.x");
    requireFinite(center.y, "center.y");
    this.#center = { ...center };
  }

  setZoom(zoom: number): void {
    this.#zoom = clampZoom(zoom, this.#minZoom, this.#maxZoom);
  }

  panByScreen(delta: Point2D): void {
    requireFinite(delta.x, "delta.x");
    requireFinite(delta.y, "delta.y");
    this.#center = {
      x: this.#center.x - delta.x / this.#zoom,
      y: this.#center.y - delta.y / this.#zoom,
    };
  }

  zoomByFactorAtScreen(factor: number, anchor: Point2D): void {
    requireFinitePositive(factor, "factor");
    this.zoomAtScreen(this.#zoom * factor, anchor);
  }

  zoomAtScreen(zoom: number, anchor: Point2D): void {
    requireFinite(anchor.x, "anchor.x");
    requireFinite(anchor.y, "anchor.y");
    const worldAnchor = this.screenToWorld(anchor);
    const nextZoom = clampZoom(zoom, this.#minZoom, this.#maxZoom);
    this.#zoom = nextZoom;
    this.#center = {
      x:
        worldAnchor.x -
        (anchor.x - this.#viewport.width / 2) / nextZoom,
      y:
        worldAnchor.y -
        (anchor.y - this.#viewport.height / 2) / nextZoom,
    };
  }

  worldToScreen(point: Point2D): Point2D {
    requireFinite(point.x, "point.x");
    requireFinite(point.y, "point.y");
    return {
      x:
        (point.x - this.#center.x) * this.#zoom +
        this.#viewport.width / 2,
      y:
        (point.y - this.#center.y) * this.#zoom +
        this.#viewport.height / 2,
    };
  }

  screenToWorld(point: Point2D): Point2D {
    requireFinite(point.x, "point.x");
    requireFinite(point.y, "point.y");
    return {
      x:
        this.#center.x +
        (point.x - this.#viewport.width / 2) / this.#zoom,
      y:
        this.#center.y +
        (point.y - this.#viewport.height / 2) / this.#zoom,
    };
  }

  worldRectToScreen(rect: Rect2D): Rect2D {
    validateRect(rect, "rect");
    const topLeft = this.worldToScreen(rect);
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: rect.width * this.#zoom,
      height: rect.height * this.#zoom,
    };
  }

  visibleWorldRect(overscanPx = 0): Rect2D {
    requireFiniteNonNegative(overscanPx, "overscanPx");
    const topLeft = this.screenToWorld({
      x: -overscanPx,
      y: -overscanPx,
    });
    const bottomRight = this.screenToWorld({
      x: this.#viewport.width + overscanPx,
      y: this.#viewport.height + overscanPx,
    });
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }

  snapshot(): Camera2DSnapshot {
    return {
      center: { ...this.#center },
      zoom: this.#zoom,
      minZoom: this.#minZoom,
      maxZoom: this.#maxZoom,
      viewport: { ...this.#viewport },
    };
  }
}

function clampZoom(zoom: number, minZoom: number, maxZoom: number): number {
  requireFinitePositive(zoom, "zoom");
  return Math.min(maxZoom, Math.max(minZoom, zoom));
}

function validateViewport(viewport: Size2D): void {
  requireFinitePositive(viewport.width, "viewport.width");
  requireFinitePositive(viewport.height, "viewport.height");
}

function validateRect(rect: Rect2D, name: string): void {
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

function requireFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}
