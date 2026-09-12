import type { MediaResourcePort } from "../ports/mediaResource";
import type { MediaKind } from "../ports/mediaScan";
import type { SourcePickerPort } from "../ports/sourcePicker";
import {
  MediaSessionController,
  type ScanState,
} from "../mediaSession";
import {
  RepresentationRequestCancelledError,
  RepresentationScheduler,
  type RepresentationPriority,
  type ThumbnailRepresentationLease,
} from "../resources/representationScheduler";
import {
  CanvasSceneModel,
  type CanvasSceneItem,
} from "./canvasSceneModel";
import type { CanvasLod } from "./canvasViewportModel";
import type {
  Camera2DSnapshot,
  Point2D,
  Rect2D,
  Size2D,
} from "../../layout/canvas/camera2d";

export type CanvasRepresentationStatus =
  | "placeholder"
  | "loading"
  | "ready"
  | "error"
  | "unsupported";

export interface CanvasBrowserItem {
  mediaId: string;
  name: string;
  relativePath: string;
  kind: MediaKind;
  worldRect: Rect2D;
  screenRect: Rect2D;
  lod: CanvasLod;
  priority: Exclude<RepresentationPriority, "prefetch">;
  representationStatus: CanvasRepresentationStatus;
  representationUri: string | null;
  representationError: string | null;
}

export interface CanvasBrowserSnapshot {
  sessionId: string | null;
  sourceDisplayName: string | null;
  scanState: ScanState | null;
  itemCount: number;
  sceneNodeCount: number;
  fallbackAspectCount: number;
  camera: Camera2DSnapshot;
  items: readonly CanvasBrowserItem[];
}

export interface CanvasBrowserViewport extends Size2D {
  devicePixelRatio: number;
}

export interface CanvasBrowserOptions {
  renderOverscanPx?: number;
  maxThumbnailEdge?: number;
  maxDetailEdge?: number;
  scanBatchSize?: number;
}

export interface CanvasBrowserDependencies {
  sessionController: MediaSessionController;
  sourcePicker: SourcePickerPort;
  representationScheduler: RepresentationScheduler;
  resourcePort: MediaResourcePort;
  scene: CanvasSceneModel;
}

export type CanvasBrowserListener = (snapshot: CanvasBrowserSnapshot) => void;

interface ResolvedCanvasBrowserOptions {
  renderOverscanPx: number;
  maxThumbnailEdge: number;
  maxDetailEdge: number;
  scanBatchSize: number;
}

type RepresentationState =
  | {
      status: "loading";
      sessionId: string;
      requestKey: string;
      priority: Exclude<RepresentationPriority, "prefetch">;
      abortController: AbortController;
    }
  | {
      status: "ready";
      sessionId: string;
      requestKey: string;
      uri: string;
      lease: ThumbnailRepresentationLease;
    }
  | {
      status: "error";
      sessionId: string;
      requestKey: string;
      message: string;
    };

const DEFAULT_OPTIONS: ResolvedCanvasBrowserOptions = {
  renderOverscanPx: 256,
  maxThumbnailEdge: 2048,
  maxDetailEdge: 4096,
  scanBatchSize: 64,
};

/**
 * Application controller for a renderer-agnostic free-canvas browser.
 *
 * The scene owns world geometry and camera math. This controller owns session
 * synchronization and the resource policy derived from visibility + LOD.
 */
export class CanvasBrowserController {
  readonly #sessionController: MediaSessionController;
  readonly #sourcePicker: SourcePickerPort;
  readonly #representationScheduler: RepresentationScheduler;
  readonly #resourcePort: MediaResourcePort;
  readonly #scene: CanvasSceneModel;
  readonly #options: ResolvedCanvasBrowserOptions;
  readonly #listeners = new Set<CanvasBrowserListener>();
  readonly #representationStates = new Map<string, RepresentationState>();
  readonly #unsubscribeSession: () => void;

  #viewport: CanvasBrowserViewport | null = null;
  #sourceDisplayName: string | null = null;
  #lastSessionId: string | null = null;
  #lastReplacementRevision = 0;
  #snapshot: CanvasBrowserSnapshot;
  #disposed = false;

  constructor(
    dependencies: CanvasBrowserDependencies,
    options: CanvasBrowserOptions = {},
  ) {
    this.#sessionController = dependencies.sessionController;
    this.#sourcePicker = dependencies.sourcePicker;
    this.#representationScheduler = dependencies.representationScheduler;
    this.#resourcePort = dependencies.resourcePort;
    this.#scene = dependencies.scene;
    this.#options = resolveOptions(options);
    this.#snapshot = emptySnapshot(this.#scene.cameraSnapshot);

    this.#unsubscribeSession = this.#sessionController.subscribe(() => {
      this.#handleSessionChange();
    });
  }

  get snapshot(): CanvasBrowserSnapshot {
    return cloneSnapshot(this.#snapshot);
  }

  subscribe(listener: CanvasBrowserListener): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async pickAndOpenSource(): Promise<boolean> {
    this.#assertActive();
    const picked = await this.#sourcePicker.pickDirectory();
    if (picked === null) {
      return false;
    }

    this.#sourceDisplayName = picked.displayName;
    this.#sessionController.openSource(picked.source, this.#options.scanBatchSize);
    return true;
  }

  async cancelScan(): Promise<boolean> {
    this.#assertActive();
    return this.#sessionController.cancelCurrent();
  }

  setViewport(viewport: CanvasBrowserViewport): void {
    this.#assertActive();
    validateViewport(viewport);
    this.#viewport = { ...viewport };
    this.#scene.setViewport({
      width: viewport.width,
      height: viewport.height,
    });
    this.#refresh();
  }

  panByScreen(delta: Point2D): void {
    this.#assertActive();
    this.#requireViewport();
    this.#scene.panByScreen(delta);
    this.#refresh();
  }

  zoomAtScreen(zoom: number, anchor: Point2D): void {
    this.#assertActive();
    this.#requireViewport();
    this.#scene.zoomAtScreen(zoom, anchor);
    this.#refresh();
  }

  zoomByFactorAtScreen(factor: number, anchor: Point2D): void {
    this.#assertActive();
    this.#requireViewport();
    this.#scene.zoomByFactorAtScreen(factor, anchor);
    this.#refresh();
  }

  fitToContent(paddingPx = 48): boolean {
    this.#assertActive();
    this.#requireViewport();
    const fitted = this.#scene.fitToContent(paddingPx);
    if (fitted) {
      this.#refresh();
    }
    return fitted;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribeSession();
    this.#cancelAllRepresentations();
    this.#listeners.clear();
  }

  #handleSessionChange(): void {
    if (this.#disposed) {
      return;
    }

    const sessionId = this.#sessionController.current?.id ?? null;
    if (sessionId !== this.#lastSessionId) {
      this.#cancelAllRepresentations();
      this.#lastSessionId = sessionId;
      this.#lastReplacementRevision = 0;
    }
    this.#refresh();
  }

  #refresh(): void {
    const session = this.#sessionController.current;
    const viewport = this.#viewport;
    if (session === null || viewport === null) {
      this.#snapshot = {
        ...emptySnapshot(this.#scene.cameraSnapshot),
        sourceDisplayName: this.#sourceDisplayName,
        sessionId: session?.id ?? null,
        scanState: session === null ? null : cloneScanState(session.scanState),
        itemCount: session?.items.size ?? 0,
      };
      this.#publish();
      return;
    }

    const replacementRevision = session.items.replacementRevision;
    if (
      this.#scene.sessionId !== session.id ||
      this.#scene.itemCount > session.items.size ||
      replacementRevision !== this.#lastReplacementRevision
    ) {
      this.#scene.sync(session.id, session.items.values());
    } else if (this.#scene.itemCount < session.items.size) {
      this.#scene.append(
        session.id,
        session.items.valuesFrom(this.#scene.itemCount),
      );
    }
    this.#lastReplacementRevision = replacementRevision;

    const visibleItems = this.#scene.queryVisible(0);
    const renderItems = this.#scene.queryVisible(this.#options.renderOverscanPx);
    const visibleIds = new Set(visibleItems.map((item) => item.mediaId));
    const renderById = new Map(renderItems.map((item) => [item.mediaId, item]));

    for (const [mediaId, state] of this.#representationStates) {
      const item = renderById.get(mediaId);
      if (
        state.sessionId !== session.id ||
        item === undefined ||
        item.lod === "placeholder" ||
        !supportsImageRepresentation(item.kind)
      ) {
        this.#releaseRepresentationState(state);
        this.#representationStates.delete(mediaId);
      }
    }

    for (const item of renderItems) {
      const priority = visibleIds.has(item.mediaId) ? "visible" : "overscan";
      this.#ensureRepresentation(
        session.id,
        item,
        priority,
        viewport.devicePixelRatio,
      );
    }

    const sceneSnapshot = this.#scene.snapshot();
    this.#snapshot = {
      sessionId: session.id,
      sourceDisplayName: this.#sourceDisplayName,
      scanState: cloneScanState(session.scanState),
      itemCount: session.items.size,
      sceneNodeCount: sceneSnapshot.nodeCount,
      fallbackAspectCount: sceneSnapshot.fallbackAspectCount,
      camera: this.#scene.cameraSnapshot,
      items: renderItems.map((item) =>
        this.#buildItem(
          item,
          visibleIds.has(item.mediaId) ? "visible" : "overscan",
        ),
      ),
    };
    this.#publish();
  }

  #ensureRepresentation(
    sessionId: string,
    item: CanvasSceneItem,
    priority: Exclude<RepresentationPriority, "prefetch">,
    devicePixelRatio: number,
  ): void {
    if (item.lod === "placeholder" || !supportsImageRepresentation(item.kind)) {
      return;
    }

    const maxEdge = calculateRepresentationEdge(
      item,
      devicePixelRatio,
      item.lod === "detail"
        ? this.#options.maxDetailEdge
        : this.#options.maxThumbnailEdge,
    );
    const requestKey = JSON.stringify([item.resourceKey, maxEdge]);
    const existing = this.#representationStates.get(item.mediaId);

    if (existing !== undefined) {
      if (existing.sessionId === sessionId && existing.requestKey === requestKey) {
        if (
          existing.status !== "loading" ||
          priorityRank(priority) <= priorityRank(existing.priority)
        ) {
          return;
        }
        existing.abortController.abort();
      } else {
        this.#releaseRepresentationState(existing);
      }
    }

    const abortController = new AbortController();
    const state: RepresentationState = {
      status: "loading",
      sessionId,
      requestKey,
      priority,
      abortController,
    };
    this.#representationStates.set(item.mediaId, state);

    let request: Promise<ThumbnailRepresentationLease>;
    try {
      request = this.#representationScheduler.requestThumbnail({
        resourceKey: item.resourceKey,
        maxEdge,
        priority,
        signal: abortController.signal,
      });
    } catch (error) {
      this.#representationStates.set(item.mediaId, {
        status: "error",
        sessionId,
        requestKey,
        message: normalizeError(error),
      });
      return;
    }

    void request.then(
      (representation) => {
        if (this.#representationStates.get(item.mediaId) !== state) {
          representation.release();
          return;
        }
        try {
          const uri = this.#resourcePort.uriFor(representation.resourceKey);
          this.#representationStates.set(item.mediaId, {
            status: "ready",
            sessionId,
            requestKey,
            uri,
            lease: representation,
          });
        } catch (error) {
          representation.release();
          this.#representationStates.set(item.mediaId, {
            status: "error",
            sessionId,
            requestKey,
            message: normalizeError(error),
          });
        }
        this.#refresh();
      },
      (error) => {
        if (this.#representationStates.get(item.mediaId) !== state) {
          return;
        }
        if (error instanceof RepresentationRequestCancelledError) {
          this.#representationStates.delete(item.mediaId);
          return;
        }
        this.#representationStates.set(item.mediaId, {
          status: "error",
          sessionId,
          requestKey,
          message: normalizeError(error),
        });
        this.#refresh();
      },
    );
  }

  #buildItem(
    item: CanvasSceneItem,
    priority: Exclude<RepresentationPriority, "prefetch">,
  ): CanvasBrowserItem {
    const state = this.#representationStates.get(item.mediaId);
    let representationStatus: CanvasRepresentationStatus;
    let representationUri: string | null = null;
    let representationError: string | null = null;

    if (!supportsImageRepresentation(item.kind)) {
      representationStatus = "unsupported";
    } else if (item.lod === "placeholder") {
      representationStatus = "placeholder";
    } else {
      representationStatus = state?.status ?? "loading";
      if (state?.status === "ready") {
        representationUri = state.uri;
      } else if (state?.status === "error") {
        representationError = state.message;
      }
    }

    return {
      mediaId: item.mediaId,
      name: item.name,
      relativePath: item.relativePath,
      kind: item.kind,
      worldRect: { ...item.worldRect },
      screenRect: { ...item.screenRect },
      lod: item.lod,
      priority,
      representationStatus,
      representationUri,
      representationError,
    };
  }

  #releaseRepresentationState(state: RepresentationState): void {
    if (state.status === "loading") {
      state.abortController.abort();
    } else if (state.status === "ready") {
      state.lease.release();
    }
  }

  #cancelAllRepresentations(): void {
    for (const state of this.#representationStates.values()) {
      this.#releaseRepresentationState(state);
    }
    this.#representationStates.clear();
  }

  #publish(): void {
    const snapshot = this.snapshot;
    for (const listener of [...this.#listeners]) {
      listener(snapshot);
    }
  }

  #requireViewport(): CanvasBrowserViewport {
    if (this.#viewport === null) {
      throw new Error("canvas viewport has not been initialized");
    }
    return this.#viewport;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("canvas browser controller is disposed");
    }
  }
}

function emptySnapshot(camera: Camera2DSnapshot): CanvasBrowserSnapshot {
  return {
    sessionId: null,
    sourceDisplayName: null,
    scanState: null,
    itemCount: 0,
    sceneNodeCount: 0,
    fallbackAspectCount: 0,
    camera: cloneCameraSnapshot(camera),
    items: [],
  };
}

function resolveOptions(options: CanvasBrowserOptions): ResolvedCanvasBrowserOptions {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  requireFiniteNonNegative(resolved.renderOverscanPx, "renderOverscanPx");
  requirePositiveInteger(resolved.maxThumbnailEdge, "maxThumbnailEdge");
  requirePositiveInteger(resolved.maxDetailEdge, "maxDetailEdge");
  requirePositiveInteger(resolved.scanBatchSize, "scanBatchSize");
  if (resolved.maxDetailEdge < resolved.maxThumbnailEdge) {
    throw new RangeError(
      "maxDetailEdge must be greater than or equal to maxThumbnailEdge",
    );
  }
  return resolved;
}

function validateViewport(viewport: CanvasBrowserViewport): void {
  requireFinitePositive(viewport.width, "viewport.width");
  requireFinitePositive(viewport.height, "viewport.height");
  requireFinitePositive(viewport.devicePixelRatio, "viewport.devicePixelRatio");
}

function calculateRepresentationEdge(
  item: CanvasSceneItem,
  devicePixelRatio: number,
  maximum: number,
): number {
  const projectedEdge = Math.max(item.screenRect.width, item.screenRect.height);
  return Math.max(1, Math.min(maximum, Math.ceil(projectedEdge * devicePixelRatio)));
}

function supportsImageRepresentation(kind: MediaKind): boolean {
  return kind === "image" || kind === "animated-image";
}

function priorityRank(
  priority: Exclude<RepresentationPriority, "prefetch">,
): number {
  return priority === "visible" ? 2 : 1;
}

function cloneScanState(state: ScanState): ScanState {
  return {
    ...state,
    summary: state.summary === null ? null : { ...state.summary },
    error: state.error === null ? null : { ...state.error },
  };
}

function cloneCameraSnapshot(camera: Camera2DSnapshot): Camera2DSnapshot {
  return {
    ...camera,
    center: { ...camera.center },
    viewport: { ...camera.viewport },
  };
}

function cloneSnapshot(snapshot: CanvasBrowserSnapshot): CanvasBrowserSnapshot {
  return {
    ...snapshot,
    scanState:
      snapshot.scanState === null ? null : cloneScanState(snapshot.scanState),
    camera: cloneCameraSnapshot(snapshot.camera),
    items: snapshot.items.map((item) => ({
      ...item,
      worldRect: { ...item.worldRect },
      screenRect: { ...item.screenRect },
    })),
  };
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as { message?: unknown };
    if (typeof candidate.message === "string") {
      return candidate.message;
    }
  }
  return String(error);
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
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
