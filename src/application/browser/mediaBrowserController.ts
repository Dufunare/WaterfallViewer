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
  type ThumbnailRepresentationLease,
} from "../resources/representationScheduler";
import type { LayoutNode } from "../../layout/types";
import type {
  ViewportQueryOptions,
  ViewportRect,
} from "../../layout/viewport/verticalViewportIndex";

export type BrowserLayoutMode = "masonry" | "justified";
export type BrowserColumnCount = "auto" | number;

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
  columnCount: BrowserColumnCount;
  justifiedTargetRowHeight: number;
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
  fixedColumnCount?: number | null;
  justifiedTargetRowHeight?: number;
  initialLayoutMode?: BrowserLayoutMode;
  /** Legacy explicit overscan. When omitted, viewport-relative windows are used. */
  overscanPx?: number;
  renderWindowScreens?: number;
  prefetchWindowScreens?: number;
  warmThumbnailCount?: number;
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
  fixedColumnCount: number | null;
  justifiedTargetRowHeight: number;
  initialLayoutMode: BrowserLayoutMode;
  overscanPx: number | null;
  renderWindowScreens: number;
  prefetchWindowScreens: number;
  warmThumbnailCount: number;
  maxThumbnailEdge: number;
  scanBatchSize: number;
}

interface BrowserLayoutSettings {
  fixedColumnCount: number | null;
  justifiedTargetRowHeight: number;
}

interface BrowserFlow {
  readonly mode: BrowserLayoutMode;
  readonly sessionId: string | null;
  readonly itemCount: number;
  readonly layoutItemCount: number;
  readonly deferredCount: number;
  readonly totalHeight: number;
  configure(viewport: BrowserViewport, settings: BrowserLayoutSettings): void;
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
      priority: RepresentationPriority;
      abortController: AbortController;
    }
  | {
      status: "ready";
      sessionId: string;
      requestKey: string;
      uri: string;
      lease: ThumbnailRepresentationLease;
      lastUsedAt: number;
    }
  | {
      status: "error";
      sessionId: string;
      requestKey: string;
      message: string;
    };

const DEFAULT_OPTIONS: Omit<ResolvedBrowserOptions, "overscanPx"> & {
  overscanPx: null;
} = {
  gap: 10,
  minColumnWidth: 220,
  maxColumns: 8,
  fixedColumnCount: null,
  justifiedTargetRowHeight: 220,
  initialLayoutMode: "masonry",
  overscanPx: null,
  renderWindowScreens: 1,
  prefetchWindowScreens: 2,
  warmThumbnailCount: 64,
  maxThumbnailEdge: 768,
  scanBatchSize: 64,
};

const THUMBNAIL_BUCKETS = [256, 512, 768] as const;

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
  #fixedColumnCount: number | null;
  #justifiedTargetRowHeight: number;
  #viewport: BrowserViewport | null = null;
  #sourceDisplayName: string | null = null;
  #lastSessionId: string | null = null;
  #lastReplacementRevision = 0;
  #snapshot: MediaBrowserSnapshot;
  #disposed = false;
  #refreshScheduled = false;
  #thumbnailUseSequence = 0;

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
    this.#fixedColumnCount = this.#options.fixedColumnCount;
    this.#justifiedTargetRowHeight = this.#options.justifiedTargetRowHeight;
    this.#flow = createFlow(this.#layoutMode, this.#options);
    this.#snapshot = emptySnapshot(
      this.#layoutMode,
      this.#fixedColumnCount,
      this.#justifiedTargetRowHeight,
    );

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
    this.#flow = createFlow(mode, this.#options);
    this.#lastReplacementRevision = 0;
    this.#refresh();
  }

  setColumnCount(columnCount: BrowserColumnCount): void {
    this.#assertActive();
    const resolved = columnCount === "auto" ? null : columnCount;
    validateFixedColumnCount(resolved, this.#options.maxColumns);
    if (resolved === this.#fixedColumnCount) {
      return;
    }
    this.#fixedColumnCount = resolved;
    this.#refresh();
  }

  setJustifiedTargetRowHeight(height: number): void {
    this.#assertActive();
    requireFinitePositive(height, "justifiedTargetRowHeight");
    if (height === this.#justifiedTargetRowHeight) {
      return;
    }
    this.#justifiedTargetRowHeight = height;
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
    if (this.#disposed) {
      return;
    }
    const session = this.#sessionController.current;
    const viewport = this.#viewport;
    if (session === null || viewport === null) {
      this.#snapshot = {
        ...emptySnapshot(
          this.#layoutMode,
          this.#fixedColumnCount,
          this.#justifiedTargetRowHeight,
        ),
        sourceDisplayName: this.#sourceDisplayName,
        sessionId: session?.id ?? null,
        scanState: session === null ? null : cloneScanState(session.scanState),
        itemCount: session?.items.size ?? 0,
      };
      this.#publish();
      return;
    }

    const settings: BrowserLayoutSettings = {
      fixedColumnCount: this.#fixedColumnCount,
      justifiedTargetRowHeight: this.#justifiedTargetRowHeight,
    };
    this.#flow.configure(viewport, settings);
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
    const renderOverscan = resolveRenderOverscan(viewport, this.#options);
    const prefetchOverscan = resolvePrefetchOverscan(viewport, this.#options);
    const renderNodes = this.#flow.queryVisible(viewportRect, {
      overscan: { top: renderOverscan, bottom: renderOverscan },
    });
    const interestNodes = this.#flow.queryVisible(viewportRect, {
      overscan: { top: prefetchOverscan, bottom: prefetchOverscan },
    });

    const visibleIds = new Set(visibleNodes.map((node) => node.mediaId));
    const renderIds = new Set(renderNodes.map((node) => node.mediaId));
    const interestIds = new Set(interestNodes.map((node) => node.mediaId));

    this.#dropInactiveThumbnailWork(session.id, renderIds, interestIds);

    // Re-evaluate every loading request against the latest viewport. Priority is
    // intentionally not monotonic: media that was visible in an old viewport
    // must be demoted when it becomes overscan/prefetch, otherwise historical
    // FIFO order can starve the user's current viewport during a long scroll.
    for (const node of visibleNodes) {
      this.#requestNodeThumbnail(
        session.id,
        session.items.get(node.mediaId),
        node,
        "visible",
        viewport,
      );
    }
    for (const node of renderNodes) {
      if (!visibleIds.has(node.mediaId)) {
        this.#requestNodeThumbnail(
          session.id,
          session.items.get(node.mediaId),
          node,
          "overscan",
          viewport,
        );
      }
    }
    for (const node of interestNodes) {
      if (!renderIds.has(node.mediaId)) {
        this.#requestNodeThumbnail(
          session.id,
          session.items.get(node.mediaId),
          node,
          "prefetch",
          viewport,
        );
      }
    }

    this.#pruneWarmThumbnails(session.id, interestIds);

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
      columnCount: this.#fixedColumnCount ?? "auto",
      justifiedTargetRowHeight: this.#justifiedTargetRowHeight,
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

  #requestNodeThumbnail(
    sessionId: string,
    media: MediaItem | undefined,
    node: LayoutNode,
    priority: RepresentationPriority,
    viewport: BrowserViewport,
  ): void {
    if (media === undefined) {
      return;
    }
    this.#ensureThumbnail(
      sessionId,
      media,
      node,
      priority,
      viewport.devicePixelRatio,
    );
  }

  #ensureThumbnail(
    sessionId: string,
    media: MediaItem,
    node: LayoutNode,
    priority: RepresentationPriority,
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

    if (existing !== undefined) {
      if (existing.sessionId === sessionId && existing.requestKey === requestKey) {
        if (existing.status === "ready") {
          existing.lastUsedAt = ++this.#thumbnailUseSequence;
          return;
        }
        if (existing.status === "loading") {
          if (priority !== existing.priority) {
            existing.priority = priority;
            this.#representationScheduler.reprioritizeThumbnail(
              { resourceKey: media.resourceKey, maxEdge },
              priority,
            );
          }
          return;
        }
        return;
      }
      this.#releaseThumbnailState(existing);
      this.#thumbnailStates.delete(media.id);
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

    let request: Promise<ThumbnailRepresentationLease>;
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
          representation.release();
          return;
        }
        try {
          const uri = this.#resourcePort.uriFor(representation.resourceKey);
          this.#thumbnailStates.set(media.id, {
            status: "ready",
            sessionId,
            requestKey,
            uri,
            lease: representation,
            lastUsedAt: ++this.#thumbnailUseSequence,
          });
        } catch (error) {
          representation.release();
          this.#thumbnailStates.set(media.id, {
            status: "error",
            sessionId,
            requestKey,
            message: normalizeError(error),
          });
        }
        this.#scheduleRefresh();
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
        this.#scheduleRefresh();
      },
    );
  }

  #dropInactiveThumbnailWork(
    sessionId: string,
    renderIds: ReadonlySet<string>,
    interestIds: ReadonlySet<string>,
  ): void {
    for (const [mediaId, state] of this.#thumbnailStates) {
      if (state.sessionId !== sessionId) {
        this.#releaseThumbnailState(state);
        this.#thumbnailStates.delete(mediaId);
        continue;
      }
      if (state.status === "loading" && !interestIds.has(mediaId)) {
        state.abortController.abort();
        this.#thumbnailStates.delete(mediaId);
      } else if (state.status === "error" && !renderIds.has(mediaId)) {
        this.#thumbnailStates.delete(mediaId);
      }
    }
  }

  #pruneWarmThumbnails(
    sessionId: string,
    interestIds: ReadonlySet<string>,
  ): void {
    const warm = [...this.#thumbnailStates.entries()]
      .filter(
        ([mediaId, state]) =>
          state.status === "ready" &&
          state.sessionId === sessionId &&
          !interestIds.has(mediaId),
      )
      .sort((left, right) => {
        const leftState = left[1];
        const rightState = right[1];
        if (leftState.status !== "ready" || rightState.status !== "ready") {
          return 0;
        }
        return rightState.lastUsedAt - leftState.lastUsedAt;
      });

    for (const [mediaId, state] of warm.slice(this.#options.warmThumbnailCount)) {
      this.#releaseThumbnailState(state);
      this.#thumbnailStates.delete(mediaId);
    }
  }

  #scheduleRefresh(): void {
    if (this.#disposed || this.#refreshScheduled) {
      return;
    }
    this.#refreshScheduled = true;
    queueMicrotask(() => {
      this.#refreshScheduled = false;
      if (!this.#disposed) {
        this.#refresh();
      }
    });
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

  #releaseThumbnailState(state: ThumbnailState): void {
    if (state.status === "loading") {
      state.abortController.abort();
    } else if (state.status === "ready") {
      state.lease.release();
    }
  }

  #cancelAllThumbnailRequests(): void {
    for (const state of this.#thumbnailStates.values()) {
      this.#releaseThumbnailState(state);
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

  configure(viewport: BrowserViewport, settings: BrowserLayoutSettings): void {
    this.#model.configure({
      viewport: { width: viewport.width, height: 0 },
      columnCount:
        settings.fixedColumnCount ?? calculateColumnCount(viewport.width, this.#options),
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

  configure(viewport: BrowserViewport, settings: BrowserLayoutSettings): void {
    this.#model.configure({
      viewport: { width: viewport.width, height: 0 },
      targetRowHeight: settings.justifiedTargetRowHeight,
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

function emptySnapshot(
  layoutMode: BrowserLayoutMode,
  fixedColumnCount: number | null,
  justifiedTargetRowHeight: number,
): MediaBrowserSnapshot {
  return {
    layoutMode,
    columnCount: fixedColumnCount ?? "auto",
    justifiedTargetRowHeight,
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
  const resolved: ResolvedBrowserOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    overscanPx: options.overscanPx ?? null,
    fixedColumnCount: options.fixedColumnCount ?? null,
  };
  requireFiniteNonNegative(resolved.gap, "gap");
  requireFinitePositive(resolved.minColumnWidth, "minColumnWidth");
  requireFinitePositive(
    resolved.justifiedTargetRowHeight,
    "justifiedTargetRowHeight",
  );
  if (resolved.overscanPx !== null) {
    requireFiniteNonNegative(resolved.overscanPx, "overscanPx");
  }
  requireFiniteNonNegative(resolved.renderWindowScreens, "renderWindowScreens");
  requireFiniteNonNegative(resolved.prefetchWindowScreens, "prefetchWindowScreens");
  if (resolved.prefetchWindowScreens < resolved.renderWindowScreens) {
    throw new RangeError("prefetchWindowScreens must be >= renderWindowScreens");
  }
  validateLayoutMode(resolved.initialLayoutMode);
  if (!Number.isInteger(resolved.maxColumns) || resolved.maxColumns <= 0) {
    throw new RangeError("maxColumns must be a positive integer");
  }
  validateFixedColumnCount(resolved.fixedColumnCount, resolved.maxColumns);
  if (!Number.isInteger(resolved.warmThumbnailCount) || resolved.warmThumbnailCount < 0) {
    throw new RangeError("warmThumbnailCount must be a non-negative integer");
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

function validateFixedColumnCount(
  count: number | null,
  maxColumns: number,
): void {
  if (count === null) {
    return;
  }
  if (!Number.isInteger(count) || count <= 0 || count > maxColumns) {
    throw new RangeError(`column count must be an integer between 1 and ${maxColumns}`);
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
  const effectiveDevicePixelRatio = Math.min(devicePixelRatio, 1.5);
  const requested = Math.max(
    1,
    Math.ceil(Math.max(node.width, node.height) * effectiveDevicePixelRatio),
  );
  const effectiveMaximum = Math.max(1, Math.min(768, maximum));
  for (const bucket of THUMBNAIL_BUCKETS) {
    if (bucket >= requested) {
      return Math.min(bucket, effectiveMaximum);
    }
  }
  return effectiveMaximum;
}

function resolveRenderOverscan(
  viewport: BrowserViewport,
  options: ResolvedBrowserOptions,
): number {
  return options.overscanPx ?? viewport.height * options.renderWindowScreens;
}

function resolvePrefetchOverscan(
  viewport: BrowserViewport,
  options: ResolvedBrowserOptions,
): number {
  return options.overscanPx === null
    ? viewport.height * options.prefetchWindowScreens
    : options.overscanPx * 2;
}

function supportsStaticThumbnail(kind: MediaKind): boolean {
  return kind === "image" || kind === "animated-image";
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
