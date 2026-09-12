import { projectMediaVisual } from "../mediaVisualProjection";
import type { MediaItem, MediaKind } from "../ports/mediaScan";
import {
  CanvasViewportModel,
  type CanvasLod,
  type CanvasViewportOptions,
} from "./canvasViewportModel";
import {
  CanvasAtlasLayoutBuilder,
  type CanvasAtlasBounds,
  type CanvasAtlasConfig,
  type CanvasAtlasNode,
} from "../../layout/canvas/canvasAtlasLayout";
import type {
  Camera2DSnapshot,
  Point2D,
  Rect2D,
  Size2D,
} from "../../layout/canvas/camera2d";

export interface CanvasSceneItem {
  mediaId: string;
  name: string;
  relativePath: string;
  kind: MediaKind;
  resourceKey: string;
  worldRect: Rect2D;
  screenRect: Rect2D;
  lod: CanvasLod;
}

export interface CanvasSceneSnapshot {
  sessionId: string | null;
  itemCount: number;
  nodeCount: number;
  fallbackAspectCount: number;
  bounds: CanvasAtlasBounds;
}

export interface CanvasSceneOptions {
  atlas: CanvasAtlasConfig;
  viewport?: CanvasViewportOptions;
}

/**
 * Session-to-world projection for the free-canvas browser.
 *
 * The common scan path appends only newly discovered media. Existing world
 * nodes keep stable coordinates. Video/audio without extracted geometry use
 * the same fallback aspect ratios as flow views. Other media with unusable
 * metadata retain a square canvas-only fallback so every scanned item remains
 * discoverable in free space.
 */
export class CanvasSceneModel {
  readonly #options: CanvasSceneOptions;
  #builder: CanvasAtlasLayoutBuilder;
  #viewport: CanvasViewportModel<CanvasAtlasNode>;
  #sessionId: string | null = null;
  #items: MediaItem[] = [];
  #fingerprints: string[] = [];
  readonly #mediaIds = new Set<string>();
  readonly #itemsById = new Map<string, MediaItem>();
  #fallbackAspectCount = 0;

  constructor(options: CanvasSceneOptions) {
    this.#options = cloneOptions(options);
    this.#builder = new CanvasAtlasLayoutBuilder(this.#options.atlas);
    this.#viewport = new CanvasViewportModel<CanvasAtlasNode>(
      this.#options.viewport,
    );
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get itemCount(): number {
    return this.#items.length;
  }

  get nodeCount(): number {
    return this.#builder.size;
  }

  get cameraSnapshot(): Camera2DSnapshot {
    return this.#viewport.cameraSnapshot;
  }

  setViewport(viewport: Size2D): void {
    this.#viewport.setViewport(viewport);
  }

  setCenter(center: Point2D): void {
    this.#viewport.setCenter(center);
  }

  panByScreen(delta: Point2D): void {
    this.#viewport.panByScreen(delta);
  }

  zoomAtScreen(zoom: number, anchor: Point2D): void {
    this.#viewport.zoomAtScreen(zoom, anchor);
  }

  zoomByFactorAtScreen(factor: number, anchor: Point2D): void {
    this.#viewport.zoomByFactorAtScreen(factor, anchor);
  }

  append(sessionId: string, items: readonly MediaItem[]): void {
    validateSessionId(sessionId);
    if (this.#sessionId !== sessionId) {
      throw new Error("append session must match the active canvas scene");
    }
    validateAppendBatch(items, this.#mediaIds);
    if (items.length === 0) {
      return;
    }

    const visuals = items.map((item) => projectCanvasVisual(item));
    const nodes = this.#builder.append(
      visuals.map((projection) => projection.visual),
    );
    this.#viewport.upsertNodes(nodes);

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      this.#items.push(cloneMediaItem(item));
      this.#fingerprints.push(sceneFingerprint(item));
      this.#mediaIds.add(item.id);
      this.#itemsById.set(item.id, cloneMediaItem(item));
      if (visuals[index].usedFallback) {
        this.#fallbackAspectCount += 1;
      }
    }
  }

  sync(sessionId: string, items: readonly MediaItem[]): void {
    validateSessionId(sessionId);
    validateUniqueIds(items);
    const nextFingerprints = items.map(sceneFingerprint);
    const canAppend =
      this.#sessionId === sessionId &&
      this.#fingerprints.length <= nextFingerprints.length &&
      prefixEquals(this.#fingerprints, nextFingerprints);

    if (!canAppend) {
      this.#rebuild(sessionId, items, this.#sessionId === sessionId);
      return;
    }

    const added = items.slice(this.#items.length);
    if (added.length > 0) {
      this.append(sessionId, added);
    }
  }

  queryVisible(overscanPx?: number): readonly CanvasSceneItem[] {
    return this.#viewport.queryVisible(overscanPx).flatMap((visible) => {
      const media = this.#itemsById.get(visible.node.mediaId);
      if (media === undefined) {
        return [];
      }
      return [
        {
          mediaId: media.id,
          name: media.name,
          relativePath: media.relativePath,
          kind: media.kind,
          resourceKey: media.resourceKey,
          worldRect: {
            x: visible.node.x,
            y: visible.node.y,
            width: visible.node.width,
            height: visible.node.height,
          },
          screenRect: { ...visible.screenRect },
          lod: visible.lod,
        },
      ];
    });
  }

  fitToContent(paddingPx = 48): boolean {
    requireFiniteNonNegative(paddingPx, "paddingPx");
    const bounds = this.#builder.bounds;
    if (bounds.width <= 0 || bounds.height <= 0) {
      return false;
    }

    const camera = this.#viewport.cameraSnapshot;
    const availableWidth = camera.viewport.width - paddingPx * 2;
    const availableHeight = camera.viewport.height - paddingPx * 2;
    if (availableWidth <= 0 || availableHeight <= 0) {
      throw new RangeError("paddingPx leaves no visible viewport area");
    }

    this.#viewport.setCenter({
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    });
    const zoom = Math.min(
      availableWidth / bounds.width,
      availableHeight / bounds.height,
    );
    this.#viewport.zoomAtScreen(zoom, {
      x: camera.viewport.width / 2,
      y: camera.viewport.height / 2,
    });
    return true;
  }

  snapshot(): CanvasSceneSnapshot {
    return {
      sessionId: this.#sessionId,
      itemCount: this.#items.length,
      nodeCount: this.#builder.size,
      fallbackAspectCount: this.#fallbackAspectCount,
      bounds: this.#builder.bounds,
    };
  }

  #rebuild(
    sessionId: string,
    items: readonly MediaItem[],
    preserveCamera: boolean,
  ): void {
    const previousCamera = this.#viewport.cameraSnapshot;
    const nextBuilder = new CanvasAtlasLayoutBuilder(this.#options.atlas);
    const nextViewport = new CanvasViewportModel<CanvasAtlasNode>(
      this.#options.viewport,
    );
    nextViewport.setViewport(previousCamera.viewport);
    if (preserveCamera) {
      nextViewport.setCenter(previousCamera.center);
      nextViewport.zoomAtScreen(previousCamera.zoom, {
        x: previousCamera.viewport.width / 2,
        y: previousCamera.viewport.height / 2,
      });
    }

    const visuals = items.map((item) => projectCanvasVisual(item));
    const nodes = nextBuilder.append(
      visuals.map((projection) => projection.visual),
    );
    nextViewport.upsertNodes(nodes);

    this.#builder = nextBuilder;
    this.#viewport = nextViewport;
    this.#sessionId = sessionId;
    this.#items = items.map(cloneMediaItem);
    this.#fingerprints = items.map(sceneFingerprint);
    this.#fallbackAspectCount = visuals.reduce(
      (count, projection) => count + (projection.usedFallback ? 1 : 0),
      0,
    );
    this.#mediaIds.clear();
    this.#itemsById.clear();
    for (const item of items) {
      this.#mediaIds.add(item.id);
      this.#itemsById.set(item.id, cloneMediaItem(item));
    }
  }
}

interface CanvasVisualProjection {
  visual: {
    mediaId: string;
    width: number;
    height: number;
  };
  usedFallback: boolean;
}

function projectCanvasVisual(item: MediaItem): CanvasVisualProjection {
  const projection = projectMediaVisual(item);
  if (projection.kind === "visual") {
    return {
      visual: {
        mediaId: item.id,
        width: projection.width,
        height: projection.height,
      },
      usedFallback: projection.source === "fallback",
    };
  }

  return {
    visual: { mediaId: item.id, width: 1, height: 1 },
    usedFallback: true,
  };
}

function sceneFingerprint(item: MediaItem): string {
  return JSON.stringify([
    item.id,
    item.name,
    item.relativePath,
    item.kind,
    item.resourceKey,
    item.visual?.width ?? null,
    item.visual?.height ?? null,
  ]);
}

function validateSessionId(sessionId: string): void {
  if (sessionId.trim().length === 0) {
    throw new RangeError("sessionId must not be empty");
  }
}

function validateUniqueIds(items: readonly MediaItem[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.id.trim().length === 0) {
      throw new RangeError("media id must not be empty");
    }
    if (ids.has(item.id)) {
      throw new RangeError(`duplicate media id: ${item.id}`);
    }
    ids.add(item.id);
  }
}

function validateAppendBatch(
  items: readonly MediaItem[],
  existingIds: ReadonlySet<string>,
): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.id.trim().length === 0) {
      throw new RangeError("media id must not be empty");
    }
    if (existingIds.has(item.id) || ids.has(item.id)) {
      throw new RangeError(`duplicate media id: ${item.id}`);
    }
    ids.add(item.id);
  }
}

function prefixEquals(previous: readonly string[], next: readonly string[]): boolean {
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }
  return true;
}

function cloneOptions(options: CanvasSceneOptions): CanvasSceneOptions {
  return {
    atlas: { ...options.atlas },
    viewport:
      options.viewport === undefined
        ? undefined
        : {
            ...options.viewport,
            camera:
              options.viewport.camera === undefined
                ? undefined
                : {
                    ...options.viewport.camera,
                    center:
                      options.viewport.camera.center === undefined
                        ? undefined
                        : { ...options.viewport.camera.center },
                    viewport:
                      options.viewport.camera.viewport === undefined
                        ? undefined
                        : { ...options.viewport.camera.viewport },
                  },
          },
  };
}

function cloneMediaItem(item: MediaItem): MediaItem {
  return {
    ...item,
    visual: item.visual === null ? null : { ...item.visual },
  };
}

function requireFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}
