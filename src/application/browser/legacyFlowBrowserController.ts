import type { MediaResourcePort } from "../ports/mediaResource";
import type { MediaItem } from "../ports/mediaScan";
import {
  MediaSessionController,
  type ScanState,
} from "../mediaSession";

export type LegacyFlowLayoutMode = "masonry" | "justified";

export interface LegacyFlowItem {
  mediaId: string;
  name: string;
  relativePath: string;
  resourceKey: string;
  resourceUri: string;
  width: number | null;
  height: number | null;
}

export interface LegacyFlowBrowserSnapshot {
  layoutMode: LegacyFlowLayoutMode;
  sessionId: string | null;
  scanState: ScanState | null;
  itemCount: number;
  /**
   * Advances when the presentation must perform the legacy equivalent of
   * `reflow()`: new session, query projection rebuild, or layout-mode change.
   * Plain scan growth keeps the same generation and only appends items.
   */
  generation: number;
  items: readonly LegacyFlowItem[];
}

export interface LegacyFlowViewport {
  width: number;
  height: number;
  scrollTop: number;
  devicePixelRatio: number;
}

export type LegacyFlowBrowserListener = (
  snapshot: LegacyFlowBrowserSnapshot,
) => void;

export class LegacyFlowBrowserController {
  readonly #sessionController: MediaSessionController;
  readonly #resourcePort: MediaResourcePort;
  readonly #listeners = new Set<LegacyFlowBrowserListener>();
  readonly #unsubscribeSession: () => void;

  #layoutMode: LegacyFlowLayoutMode = "masonry";
  #generation = 0;
  #lastSessionId: string | null = null;
  #lastReplacementRevision = 0;
  #snapshot: LegacyFlowBrowserSnapshot = emptySnapshot();
  #disposed = false;

  constructor(
    sessionController: MediaSessionController,
    resourcePort: MediaResourcePort,
  ) {
    this.#sessionController = sessionController;
    this.#resourcePort = resourcePort;
    this.#unsubscribeSession = sessionController.subscribe(() => {
      this.#refreshFromSession();
    });
  }

  get snapshot(): LegacyFlowBrowserSnapshot {
    return cloneSnapshot(this.#snapshot);
  }

  subscribe(listener: LegacyFlowBrowserListener): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  setLayoutMode(mode: LegacyFlowLayoutMode): void {
    this.#assertActive();
    if (mode !== "masonry" && mode !== "justified") {
      throw new RangeError(`unsupported layout mode: ${String(mode)}`);
    }
    if (mode === this.#layoutMode) {
      return;
    }
    this.#layoutMode = mode;
    this.#generation += 1;
    this.#refreshFromSession(true);
  }

  /**
   * Kept as a compatibility seam for existing runtime/tests. The legacy Flow
   * experiment deliberately does not drive loading from viewport snapshots;
   * native DOM scrolling and the presentation's `loadNext()` gate own that.
   */
  setViewport(viewport: LegacyFlowViewport): void {
    this.#assertActive();
    validateViewport(viewport);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribeSession();
    this.#listeners.clear();
  }

  #refreshFromSession(forceGeneration = false): void {
    if (this.#disposed) {
      return;
    }

    const session = this.#sessionController.current;
    if (session === null) {
      if (this.#lastSessionId !== null || forceGeneration) {
        this.#generation += forceGeneration ? 0 : 1;
      }
      this.#lastSessionId = null;
      this.#lastReplacementRevision = 0;
      this.#snapshot = {
        ...emptySnapshot(),
        layoutMode: this.#layoutMode,
        generation: this.#generation,
      };
      this.#publish();
      return;
    }

    const replacementRevision = session.items.replacementRevision;
    const sessionChanged = session.id !== this.#lastSessionId;
    const projectionRebuilt =
      !sessionChanged && replacementRevision !== this.#lastReplacementRevision;

    if (sessionChanged || projectionRebuilt) {
      this.#generation += 1;
    }

    this.#lastSessionId = session.id;
    this.#lastReplacementRevision = replacementRevision;

    const items = session.items
      .values()
      .filter(isLegacyRenderableImage)
      .map((item) => this.#toLegacyItem(item));

    this.#snapshot = {
      layoutMode: this.#layoutMode,
      sessionId: session.id,
      scanState: cloneScanState(session.scanState),
      itemCount: session.items.size,
      generation: this.#generation,
      items,
    };
    this.#publish();
  }

  #toLegacyItem(item: MediaItem): LegacyFlowItem {
    return {
      mediaId: item.id,
      name: item.name,
      relativePath: item.relativePath,
      resourceKey: item.resourceKey,
      resourceUri: this.#resourcePort.uriFor(item.resourceKey),
      width: item.visual?.width ?? null,
      height: item.visual?.height ?? null,
    };
  }

  #publish(): void {
    const snapshot = this.snapshot;
    for (const listener of [...this.#listeners]) {
      listener(snapshot);
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("legacy flow browser controller is disposed");
    }
  }
}

function isLegacyRenderableImage(item: MediaItem): boolean {
  return item.kind === "image" || item.kind === "animated-image";
}

function emptySnapshot(): LegacyFlowBrowserSnapshot {
  return {
    layoutMode: "masonry",
    sessionId: null,
    scanState: null,
    itemCount: 0,
    generation: 0,
    items: [],
  };
}

function cloneSnapshot(
  snapshot: LegacyFlowBrowserSnapshot,
): LegacyFlowBrowserSnapshot {
  return {
    ...snapshot,
    scanState:
      snapshot.scanState === null ? null : cloneScanState(snapshot.scanState),
    items: snapshot.items.map((item) => ({ ...item })),
  };
}

function cloneScanState(state: ScanState): ScanState {
  return {
    ...state,
    summary: state.summary === null ? null : { ...state.summary },
    error: state.error === null ? null : { ...state.error },
  };
}

function validateViewport(viewport: LegacyFlowViewport): void {
  requireFinitePositive(viewport.width, "viewport.width");
  requireFinitePositive(viewport.height, "viewport.height");
  requireFiniteNonNegative(viewport.scrollTop, "viewport.scrollTop");
  requireFinitePositive(viewport.devicePixelRatio, "viewport.devicePixelRatio");
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
