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
  renderableItemCount: number;
  generation: number;
}

export type LegacyFlowBrowserEvent =
  | {
      type: "reset";
      snapshot: LegacyFlowBrowserSnapshot;
      items: readonly LegacyFlowItem[];
    }
  | {
      type: "append";
      snapshot: LegacyFlowBrowserSnapshot;
      items: readonly LegacyFlowItem[];
    }
  | {
      type: "state";
      snapshot: LegacyFlowBrowserSnapshot;
    };

export interface LegacyFlowViewport {
  width: number;
  height: number;
  scrollTop: number;
  devicePixelRatio: number;
}

export type LegacyFlowBrowserListener = (event: LegacyFlowBrowserEvent) => void;

export class LegacyFlowBrowserController {
  readonly #sessionController: MediaSessionController;
  readonly #resourcePort: MediaResourcePort;
  readonly #listeners = new Set<LegacyFlowBrowserListener>();
  readonly #unsubscribeSession: () => void;

  #layoutMode: LegacyFlowLayoutMode = "masonry";
  #generation = 0;
  #lastSessionId: string | null = null;
  #lastReplacementRevision = 0;
  #lastProjectionSize = 0;
  #renderableItemCount = 0;
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
    listener({
      type: "reset",
      snapshot: this.snapshot,
      items: this.#currentRenderableItems(),
    });
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
    const items = this.#currentRenderableItems();
    this.#renderableItemCount = items.length;
    this.#snapshot = this.#buildSnapshot();
    this.#publish({ type: "reset", snapshot: this.snapshot, items });
  }

  /**
   * Compatibility seam for shared runtime tests. Legacy Flow deliberately does
   * not derive loading or DOM state from viewport snapshots.
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

  #refreshFromSession(): void {
    if (this.#disposed) {
      return;
    }

    const session = this.#sessionController.current;
    if (session === null) {
      const hadSession = this.#lastSessionId !== null;
      if (hadSession) {
        this.#generation += 1;
      }
      this.#lastSessionId = null;
      this.#lastReplacementRevision = 0;
      this.#lastProjectionSize = 0;
      this.#renderableItemCount = 0;
      this.#snapshot = {
        ...emptySnapshot(),
        layoutMode: this.#layoutMode,
        generation: this.#generation,
      };
      this.#publish({ type: "reset", snapshot: this.snapshot, items: [] });
      return;
    }

    const replacementRevision = session.items.replacementRevision;
    const projectionSize = session.items.size;
    const sessionChanged = session.id !== this.#lastSessionId;
    const projectionRebuilt =
      !sessionChanged &&
      (replacementRevision !== this.#lastReplacementRevision ||
        projectionSize < this.#lastProjectionSize);

    if (sessionChanged || projectionRebuilt) {
      this.#generation += 1;
      const items = session.items
        .values()
        .filter(isLegacyRenderableImage)
        .map((item) => this.#toLegacyItem(item));
      this.#renderableItemCount = items.length;
      this.#lastSessionId = session.id;
      this.#lastReplacementRevision = replacementRevision;
      this.#lastProjectionSize = projectionSize;
      this.#snapshot = this.#buildSnapshot();
      this.#publish({ type: "reset", snapshot: this.snapshot, items });
      return;
    }

    let appended: LegacyFlowItem[] = [];
    if (projectionSize > this.#lastProjectionSize) {
      appended = session.items
        .valuesFrom(this.#lastProjectionSize)
        .filter(isLegacyRenderableImage)
        .map((item) => this.#toLegacyItem(item));
      this.#renderableItemCount += appended.length;
    }

    this.#lastSessionId = session.id;
    this.#lastReplacementRevision = replacementRevision;
    this.#lastProjectionSize = projectionSize;
    this.#snapshot = this.#buildSnapshot();

    if (appended.length > 0) {
      this.#publish({
        type: "append",
        snapshot: this.snapshot,
        items: appended,
      });
    } else {
      this.#publish({ type: "state", snapshot: this.snapshot });
    }
  }

  #currentRenderableItems(): LegacyFlowItem[] {
    const session = this.#sessionController.current;
    if (session === null) {
      return [];
    }
    return session.items
      .values()
      .filter(isLegacyRenderableImage)
      .map((item) => this.#toLegacyItem(item));
  }

  #buildSnapshot(): LegacyFlowBrowserSnapshot {
    const session = this.#sessionController.current;
    return {
      layoutMode: this.#layoutMode,
      sessionId: session?.id ?? null,
      scanState: session === null ? null : cloneScanState(session.scanState),
      itemCount: session?.items.size ?? 0,
      renderableItemCount: this.#renderableItemCount,
      generation: this.#generation,
    };
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

  #publish(event: LegacyFlowBrowserEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(cloneEvent(event));
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
    renderableItemCount: 0,
    generation: 0,
  };
}

function cloneEvent(event: LegacyFlowBrowserEvent): LegacyFlowBrowserEvent {
  if (event.type === "state") {
    return { type: "state", snapshot: cloneSnapshot(event.snapshot) };
  }
  return {
    type: event.type,
    snapshot: cloneSnapshot(event.snapshot),
    items: event.items.map((item) => ({ ...item })),
  };
}

function cloneSnapshot(
  snapshot: LegacyFlowBrowserSnapshot,
): LegacyFlowBrowserSnapshot {
  return {
    ...snapshot,
    scanState:
      snapshot.scanState === null ? null : cloneScanState(snapshot.scanState),
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
