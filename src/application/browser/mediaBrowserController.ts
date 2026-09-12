import { JustifiedFlowModel } from "../flow/justifiedFlowModel";
import { MasonryFlowModel } from "../flow/masonryFlowModel";
import type { MediaResourcePort } from "../ports/mediaResource";
import type { MediaItem, MediaKind } from "../ports/mediaScan";
import type { SourcePickerPort } from "../ports/sourcePicker";
import {
  MediaSessionController,
  type ScanState,
} from "../mediaSession";
import {
  RepresentationRequestCancelledError,
  RepresentationScheduler,
  type RepresentationPriority,
} from "../resources/representationScheduler";
import type { LayoutNode } from "../../layout/types";
import type {
  ViewportQueryOptions,
  ViewportRect,
} from "../../layout/viewport/verticalViewportIndex";

export type BrowserLayoutMode = "masonry" | "justified";

export type BrowserThumbnailStatus =
  | "loading"
  | "ready"
  | "error"
  | "unsupported";

export interface BrowserTile {
  mediaId: string;
  name: string;
  relativePath: string;
  kind: MediaKind;
  x: number;
  y: number;
  width: number;
  height: number;
  priority: Exclude<RepresentationPriority, "prefetch">;
  thumbnailStatus: BrowserThumbnailStatus;
  thumbnailUri: string | null;
  thumbnailError: string | null;
}

export interface MediaBrowserSnapshot {
  layoutMode: BrowserLayoutMode;
  sessionId: string | null;
  sourceDisplayName: string | null;
  scanState: ScanState | null;
  itemCount: number;
  layoutItemCount: number;
  deferredCount: number;
  totalHeight: number;
  tiles: readonly BrowserTile[];
}

export interface BrowserViewport {
  width: number;
  height: number;
  scrollTop: number;
  devicePixelRatio: number;
}

export interface MediaBrowserOptions {
  gap?: number;
  minColumnWidth?: number;
  maxColumns?: number;
  justifiedTargetRowHeight?: number;
  initialLayoutMode?: BrowserLayoutMode;
  overscanPx?: number;
  maxThumbnailEdge?: number;
  scanBatchSize?: number;
}

export interface MediaBrowserDependencies {
  sessionController: MediaSessionController;
  sourcePicker: SourcePickerPort;
  representationScheduler: RepresentationScheduler;
  resourcePort: MediaResourcePort;
}

export type MediaBrowserListener = (snapshot: MediaBrowserSnapshot) => void;

interface ResolvedBrowserOptions {
  gap: number;
  minColumnWidth: number;
  maxColumns: number;
  justifiedTargetRowHeight: number;
  initialLayoutMode: BrowserLayoutMode;
  overscanPx: number;
  maxThumbnailEdge: number;
  scanBatchSize: number;
}

interface BrowserFlow {
  readonly mode: BrowserLayoutMode;
  readonly sessionId: string | null;
  readonly itemCount: number;
  readonly layoutItemCount: number;
  readonly deferredCount: number;
  readonly totalHeight: number;
  configure(viewport: BrowserViewport): void;
  append(sessionId: string, items: readonly MediaItem[]): void;
  sync(sessionId: string, items: readonly MediaItem[], terminal: boolean): void;
  markTerminal(): void;
  queryVisible(
    viewport: ViewportRect,
    options?: ViewportQueryOptions,
  ): readonly LayoutNode[];
}

type ThumbnailState =
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
    }
  | {
      status: "error";
      sessionId: string;
      requestKey: string;
      message: string;
    };

const DEFAULT_OPTIONS: ResolvedBrowserOptions = {
  gap: 10,
  minColumnWidth: 220,
  maxColumns: 8,
  justifiedTargetRowHeight: 220,
  initialLayoutMode: "masonry",
  overscanPx: 900,
  maxThumbnailEdge: 4096,
  scanBatchSize: 64,
};

export class MediaBrowserController {
  readonly #sessionController: MediaSessionController;
  readonly #sourcePicker: SourcePickerPort;
  readonly #representationScheduler: RepresentationScheduler;
  readonly #resourcePort: MediaResourcePort;
  readonly #options: ResolvedBrowserOptions;
  readonly #listeners = new Set<MediaBrowserListener>();
  readonly #thumbnailStates = new Map<string, ThumbnailState>();
  readonly #unsubscribeSession: () => void;

  #flow: BrowserFlow;
  #layoutMode: BrowserLayoutMode;
  #viewport: BrowserViewport | null = null;
  #sourceDisplayName: string | null = null;
  #lastSessionId: string | null = null;
  #lastReplacementRevision = 0;
  #snapshot: MediaBrowserSnapshot;
  #disposed = false;

  constructor(
    dependencies: MediaBrowserDependencies,
    options: MediaBrowserOptions = {},
  ) {
    this.#sessionController = dependencies.sessionController;
    this.#sourcePicker = dependencies.sourcePicker;
    this.#representationScheduler = dependencies.representationScheduler;
    this.#resourcePort = dependencies.resourcePort;
    this.#options = resolveOptions(options);
    this.#layoutMode = this.#options.initialLayoutMode;
    this.#flow = createFlow(this.#layoutMode, this.#options);
    this.#snapshot = emptySnapshot(this.#layoutMode);

    this.#unsubscribeSession = this.#sessionController.subscribe(() => {
      this.#handleSessionChange();
    });
  }

  get snapshot(): MediaBrowserSnapshot {
    return cloneSnapshot(this.#snapshot);
  }

  subscribe(listener: MediaBrowserListener): () => void {
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

  setViewport(viewport: BrowserViewport): void {
    this.#assertActive();
    validateViewport(viewport);
    this.#viewport = { ...viewport };
    this.#refresh();
  }

  setLayoutMode(mode: BrowserLayoutMode): void {
    this.#assertActive();
    validateLayoutMode(mode);
    if (mode === this.#layoutMode) {
      return;
    }

    this.#layoutMode = mode;
    this.#cancelAllThumbnailRequests();
    this.#flow = createFlow(mode, this.#options);
    this.#lastReplacementRevision = 0;
    this.#refresh();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribeSession();
    this.#cancelAllThumbnailRequests();
    this.#listeners.clear();
  }

  #handleSessionChange(): void {
    if (this.#disposed) {
      return;
    }

    const sessionId = this.#sessionController.current?.id ?? null;
    if (sessionId !== this.#lastSessionId) {
      this.#cancelAllThumbnailRequests();
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
        ...emptySnapshot(this.#layoutMode),
        sourceDisplayName: this.#sourceDisplayName,
        sessionId: session?.id ?? null,
        scanState: session === null ? null : cloneScanState(session.scanState),
        itemCount: session?.items.size ?? 0,
      };
      this.#publish();
      return;
    }

    this.#flow.configure(viewport);
    const terminal = isTerminalScanState(session.scanState);
    const replacementRevision = session.items.replacementRevision;
    if (
      this.#flow.sessionId !== session.id ||
      this.#flow.itemCount > session.items.size ||
      replacementRevision !== this.#lastReplacementRevision
    ) {
      this.#flow.sync(session.id, session.items.values(), terminal);
    } else {
      if (this.#flow.itemCount < session.items.size) {
        this.#flow.append(
          session.id,
          session.items.valuesFrom(this.#flow.itemCount),
        );
      }
      if (terminal) {
        this.#flow.markTerminal();
      }
    }
    this.#lastReplacementRevision = replacementRevision;

    const viewportRect: ViewportRect = {
      x: 0,
      y: viewport.scrollTop,
      width: viewport.width,
      height: viewport.height,
    };
    const visibleNodes = this.#flow.queryVisible(viewportRect);
    const renderNodes = this.#flow.queryVisible(viewportRect, {
      overscan: {
        top: this.#options.overscanPx,
        bottom: this.#options.overscanPx,
      },
    });
    const visibleIds = new Set(visibleNodes.map((node) => node.mediaId));
    const renderIds = new Set(renderNodes.map((node) => node.mediaId));

    for (const [mediaId, state] of this.#thumbnailStates) {
      if (state.sessionId !== session.id || !renderIds.has(mediaId)) {
        if (state.status === "loading") {
          state.abortController.abort();
        }
        this.#thumbnailStates.delete(mediaId);
      }
    }

    for (const node of renderNodes) {
      const media = session.items.get(node.mediaId);
      if (media === undefined) {
        continue;
      }
      const priority = visibleIds.has(node.mediaId) ? "visible" : "overscan";
      this.#ensureThumbnail(
        session.id,
        media,
        node,
        priority,
        viewport.devicePixelRatio,
      );
    }

    const tiles = renderNodes.flatMap((node) => {
      const media = session.items.get(node.mediaId);
      if (media === undefined) {
        return [];
      }
      const priority = visibleIds.has(node.mediaId) ? "visible" : "overscan";
      return [this.#buildTile(media, node, priority)];
    });

    this.#snapshot = {
      layoutMode: this.#layoutMode,
      sessionId: session.id,
      sourceDisplayName: this.#sourceDisplayName,
      scanState: cloneScanState(session.scanState),
      itemCount: session.items.size,
      layoutItemCount: this.#flow.layoutItemCount,
      deferredCount: this.#flow.deferredCount,
      totalHeight: this.#flow.totalHeight,
      tiles,
    };
    this.#publish();
  }

  #ensureThumbnail(
    sessionId: string,
    media: MediaItem,
    node: LayoutNode,
    priority: Exclude<RepresentationPriority, "prefetch">,
    devicePixelRatio: number,
  ): void {
    if (!supportsStaticThumbnail(media.kind)) {
      return;
    }

    const maxEdge = calculateThumbnailEdge(
      node,
      devicePixelRatio,
      this.#options.maxThumbnailEdge,
    );
    const requestKey = JSON.stringify([media.resourceKey, maxEdge]);
    const existing = this.#thumbnailStates.get(media.id);

    if (existing !== undefined && existing.sessionId === sessionId) {
      if (existing.requestKey === requestKey) {
        if (
          existing.status !== "loading" ||
          priorityRank(priority) <= priorityRank(existing.priority)
        ) {
          return;
        }
        existing.abortController.abort();
      } else if (existing.status === "loading") {
        existing.abortController.abort();
      }
    }

    const abortController = new AbortController();
    const state: ThumbnailState = {
      status: "loading",
      sessionId,
      requestKey,
      priority,
      abortController,
    };
    this.#thumbnailStates.set(media.id, state);

    let request: Promise<{ resourceKey: string; width: number; height: number }>;
    try {
      request = this.#representationScheduler.requestThumbnail({
        resourceKey: media.resourceKey,
        maxEdge,
        priority,
        signal: abortController.signal,
      });
    } catch (error) {
      this.#thumbnailStates.set(media.id, {
        status: "error",
        sessionId,
        requestKey,
        message: normalizeError(error),
      });
      return;
    }

    void request.then(
      (representation) => {
        if (this.#thumbnailStates.get(media.id) !== state) {
          return;
        }
        try {
          const uri = this.#resourcePort.uriFor(representation.resourceKey);
          this.#thumbnailStates.set(media.id, {
            status: "ready",
            sessionId,
            requestKey,
            uri,
          });
        } catch (error) {
          this.#thumbnailStates.set(media.id, {
            status: "error",
            sessionId,
            requestKey,
            message: normalizeError(error),
          });
        }
        this.#refresh();
      },
      (error) => {
        if (this.#thumbnailStates.get(media.id) !== state) {
          return;
        }
        if (error instanceof RepresentationRequestCancelledError) {
          this.#thumbnailStates.delete(media.id);
          return;
        }
        this.#thumbnailStates.set(media.id, {
          status: "error",
          sessionId,
          requestKey,
          message: normalizeError(error),
        });
        this.#refresh();
      },
    );
  }

  #buildTile(
    media: MediaItem,
    node: LayoutNode,
    priority: Exclude<RepresentationPriority, "prefetch">,
  ): BrowserTile {
    const state = this.#thumbnailStates.get(media.id);
    let thumbnailStatus: BrowserThumbnailStatus = "unsupported";
    let thumbnailUri: string | null = null;
    let thumbnailError: string | null = null;

    if (supportsStaticThumbnail(media.kind)) {
      thumbnailStatus = state?.status ?? "loading";
      if (state?.status === "ready") {
        thumbnailUri = state.uri;
      } else if (state?.status === "error") {
        thumbnailError = state.message;
      }
    }

    return {
      mediaId: media.id,
      name: media.name,
      relativePath: media.relativePath,
      kind: media.kind,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      priority,
      thumbnailStatus,
      thumbnailUri,
      thumbnailError,
    };
  }

  #cancelAllThumbnailRequests(): void {
    for (const state of this.#thumbnailStates.values()) {
      if (state.status === "loading") {
        state.abortController.abort();
      }
    }
    this.#thumbnailStates.clear();
  }

  #publish(): void {
    const snapshot = this.snapshot;
    for (const listener of [...this.#listeners]) {
      listener(snapshot);
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("media browser controller is disposed");
    }
  }
}

class MasonryBrowserFlow implements BrowserFlow {
  readonly mode = "masonry" as const;
  readonly #model: MasonryFlowModel;
  readonly #options: ResolvedBrowserOptions;

  constructor(options: ResolvedBrowserOptions) {
    this.#options = options;
    this.#model = new MasonryFlowModel({
      viewport: { width: 1, height: 0 },
      columnCount: 1,
      gap: options.gap,
    });
  }

  get sessionId(): string | null {
    return this.#model.sessionId;
  }

  get itemCount(): number {
    return this.#model.itemCount;
  }

  get layoutItemCount(): number {
    return this.#model.layoutItemCount;
  }

  get deferredCount(): number {
    return this.#model.deferredCount;
  }

  get totalHeight(): number {
    return this.#model.totalHeight;
  }

  configure(viewport: BrowserViewport): void {
    this.#model.configure({
      viewport: { width: viewport.width, height: viewport.height },
      columnCount: calculateColumnCount(viewport.width, this.#options),
      gap: this.#options.gap,
    });
  }

  append(sessionId: string, items: readonly MediaItem[]): void {
    this.#model.append(sessionId, items);
  }

  sync(sessionId: string, items: readonly MediaItem[]): void {
    this.#model.sync(sessionId, items);
  }

  markTerminal(): void {}

  queryVisible(
    viewport: ViewportRect,
    options: ViewportQueryOptions = {},
  ): readonly LayoutNode[] {
    return this.#model.queryVisible(viewport, options);
  }
}

class JustifiedBrowserFlow implements BrowserFlow {
  readonly mode = "justified" as const;
  readonly #model: JustifiedFlowModel;
  readonly #options: ResolvedBrowserOptions;

  constructor(options: ResolvedBrowserOptions) {
    this.#options = options;
    this.#model = new JustifiedFlowModel({
      viewport: { width: 1, height: 0 },
      targetRowHeight: options.justifiedTargetRowHeight,
      gap: options.gap,
    });
  }

  get sessionId(): string | null {
    return this.#model.sessionId;
  }

  get itemCount(): number {
    return this.#model.itemCount;
  }

  get layoutItemCount(): number {
    return this.#model.layoutItemCount;
  }

  get deferredCount(): number {
    return this.#model.deferredCount;
  }

  get totalHeight(): number {
    return this.#model.totalHeight;
  }

  configure(viewport: BrowserViewport): void {
    this.#model.configure({
      viewport: { width: viewport.width, height: viewport.height },
      targetRowHeight: this.#options.justifiedTargetRowHeight,
      gap: this.#options.gap,
    });
  }

  append(sessionId: string, items: readonly MediaItem[]): void {
    this.#model.append(sessionId, items);
  }

  sync(
    sessionId: string,
    items: readonly MediaItem[],
    terminal: boolean,
  ): void {
    this.#model.sync(sessionId, items, terminal);
  }

  markTerminal(): void {
    this.#model.markTerminal();
  }

  queryVisible(
    viewport: ViewportRect,
    options: ViewportQueryOptions = {},
  ): readonly LayoutNode[] {
    return this.#model.queryVisible(viewport, options);
  }
}

function createFlow(
  mode: BrowserLayoutMode,
  options: ResolvedBrowserOptions,
): BrowserFlow {
  switch (mode) {
    case "masonry":
      return new MasonryBrowserFlow(options);
    case "justified":
      return new JustifiedBrowserFlow(options);
  }
}

function emptySnapshot(layoutMode: BrowserLayoutMode): MediaBrowserSnapshot {
  return {
    layoutMode,
    sessionId: null,
    sourceDisplayName: null,
    scanState: null,
    itemCount: 0,
    layoutItemCount: 0,
    deferredCount: 0,
    totalHeight: 0,
    tiles: [],
  };
}

function resolveOptions(options: MediaBrowserOptions): ResolvedBrowserOptions {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  requireFiniteNonNegative(resolved.gap, "gap");
  requireFinitePositive(resolved.minColumnWidth, "minColumnWidth");
  requireFinitePositive(
    resolved.justifiedTargetRowHeight,
    "justifiedTargetRowHeight",
  );
  requireFiniteNonNegative(resolved.overscanPx, "overscanPx");
  validateLayoutMode(resolved.initialLayoutMode);
  if (!Number.isInteger(resolved.maxColumns) || resolved.maxColumns <= 0) {
    throw new RangeError("maxColumns must be a positive integer");
  }
  if (
    !Number.isInteger(resolved.maxThumbnailEdge) ||
    resolved.maxThumbnailEdge <= 0
  ) {
    throw new RangeError("maxThumbnailEdge must be a positive integer");
  }
  if (!Number.isInteger(resolved.scanBatchSize) || resolved.scanBatchSize <= 0) {
    throw new RangeError("scanBatchSize must be a positive integer");
  }
  return resolved;
}

function validateLayoutMode(mode: BrowserLayoutMode): void {
  if (mode !== "masonry" && mode !== "justified") {
    throw new RangeError(`unsupported layout mode: ${String(mode)}`);
  }
}

function validateViewport(viewport: BrowserViewport): void {
  requireFinitePositive(viewport.width, "viewport.width");
  requireFinitePositive(viewport.height, "viewport.height");
  requireFiniteNonNegative(viewport.scrollTop, "viewport.scrollTop");
  requireFinitePositive(viewport.devicePixelRatio, "viewport.devicePixelRatio");
}

function calculateColumnCount(
  viewportWidth: number,
  options: ResolvedBrowserOptions,
): number {
  const count = Math.floor(
    (viewportWidth + options.gap) / (options.minColumnWidth + options.gap),
  );
  return Math.max(1, Math.min(options.maxColumns, count));
}

function calculateThumbnailEdge(
  node: LayoutNode,
  devicePixelRatio: number,
  maximum: number,
): number {
  const requested = Math.ceil(
    Math.max(node.width, node.height) * devicePixelRatio,
  );
  return Math.max(1, Math.min(maximum, requested));
}

function supportsStaticThumbnail(kind: MediaKind): boolean {
  return kind === "image" || kind === "animated-image";
}

function priorityRank(
  priority: Exclude<RepresentationPriority, "prefetch">,
): number {
  return priority === "visible" ? 2 : 1;
}

function isTerminalScanState(state: ScanState): boolean {
  return (
    state.status === "finished" ||
    state.status === "cancelled" ||
    state.status === "failed"
  );
}

function cloneScanState(state: ScanState): ScanState {
  return {
    ...state,
    summary: state.summary === null ? null : { ...state.summary },
    error: state.error === null ? null : { ...state.error },
  };
}

function cloneSnapshot(snapshot: MediaBrowserSnapshot): MediaBrowserSnapshot {
  return {
    ...snapshot,
    scanState:
      snapshot.scanState === null ? null : cloneScanState(snapshot.scanState),
    tiles: snapshot.tiles.map((tile) => ({ ...tile })),
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
