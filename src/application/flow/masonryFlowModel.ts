import type { MediaItem } from "../ports/mediaScan";
import {
  MasonryLayoutBuilder,
  type MasonryLayoutConfig,
  type MasonryLayoutNode,
  type MasonryLayoutResult,
} from "../../layout/masonry/masonryLayout";
import {
  VerticalViewportIndex,
  type ViewportQueryOptions,
  type ViewportRect,
} from "../../layout/viewport/verticalViewportIndex";

export type DeferredMediaReason = "missing-visual" | "invalid-visual";

export interface DeferredMedia {
  mediaId: string;
  reason: DeferredMediaReason;
}

export interface MasonryFlowSnapshot {
  sessionId: string | null;
  itemCount: number;
  layoutItemCount: number;
  deferredMedia: readonly DeferredMedia[];
  layout: MasonryLayoutResult;
}

/**
 * Application-facing projection from an ordered media session into Masonry
 * geometry plus viewport virtualization.
 *
 * The common scan path is append-only, so `sync` extends both layout and
 * viewport indexes incrementally. If an already-seen item's layout-relevant
 * visual metadata changes, the source order changes, the session changes, or
 * layout configuration changes, the model rebuilds deterministically.
 */
export class MasonryFlowModel {
  #config: MasonryLayoutConfig;
  #builder: MasonryLayoutBuilder;
  #viewportIndex = new VerticalViewportIndex<MasonryLayoutNode>();
  #sessionId: string | null = null;
  #items: MediaItem[] = [];
  #fingerprints: string[] = [];
  #deferredMedia: DeferredMedia[] = [];

  constructor(config: MasonryLayoutConfig) {
    this.#builder = new MasonryLayoutBuilder(config);
    this.#config = cloneConfig(config);
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get itemCount(): number {
    return this.#items.length;
  }

  configure(config: MasonryLayoutConfig): void {
    if (sameConfig(this.#config, config)) {
      return;
    }

    this.#rebuild(this.#sessionId, this.#items, config);
  }

  sync(sessionId: string, items: readonly MediaItem[]): void {
    if (sessionId.trim().length === 0) {
      throw new RangeError("sessionId must not be empty");
    }
    validateUniqueIds(items);

    const nextFingerprints = items.map(layoutFingerprint);
    const canAppend =
      this.#sessionId === sessionId &&
      this.#fingerprints.length <= nextFingerprints.length &&
      prefixEquals(this.#fingerprints, nextFingerprints);

    if (!canAppend) {
      this.#rebuild(sessionId, items, this.#config);
      return;
    }

    const previousLength = this.#items.length;
    const addedItems = items.slice(previousLength);
    if (addedItems.length > 0) {
      this.#appendItems(addedItems);
    }

    this.#sessionId = sessionId;
    this.#items = items.map(cloneMediaItem);
    this.#fingerprints = nextFingerprints;
  }

  queryVisible(
    viewport: ViewportRect,
    options: ViewportQueryOptions = {},
  ): readonly MasonryLayoutNode[] {
    return this.#viewportIndex.query(viewport, options);
  }

  snapshot(): MasonryFlowSnapshot {
    const layout = this.#builder.snapshot();
    return {
      sessionId: this.#sessionId,
      itemCount: this.#items.length,
      layoutItemCount: layout.nodes.length,
      deferredMedia: this.#deferredMedia.map((item) => ({ ...item })),
      layout,
    };
  }

  #appendItems(items: readonly MediaItem[]): void {
    const visualItems = [];

    for (const item of items) {
      const projection = projectVisual(item);
      if (projection.kind === "deferred") {
        this.#deferredMedia.push({
          mediaId: item.id,
          reason: projection.reason,
        });
        continue;
      }

      visualItems.push({
        mediaId: item.id,
        width: projection.width,
        height: projection.height,
      });
    }

    if (visualItems.length === 0) {
      return;
    }

    const nodes = this.#builder.append(visualItems);
    this.#viewportIndex.append(nodes);
  }

  #rebuild(
    sessionId: string | null,
    items: readonly MediaItem[],
    config: MasonryLayoutConfig,
  ): void {
    const nextBuilder = new MasonryLayoutBuilder(config);
    const nextViewportIndex = new VerticalViewportIndex<MasonryLayoutNode>();
    const nextDeferred: DeferredMedia[] = [];
    const visualItems = [];

    for (const item of items) {
      const projection = projectVisual(item);
      if (projection.kind === "deferred") {
        nextDeferred.push({ mediaId: item.id, reason: projection.reason });
        continue;
      }

      visualItems.push({
        mediaId: item.id,
        width: projection.width,
        height: projection.height,
      });
    }

    const nodes = nextBuilder.append(visualItems);
    nextViewportIndex.append(nodes);

    this.#config = cloneConfig(config);
    this.#builder = nextBuilder;
    this.#viewportIndex = nextViewportIndex;
    this.#sessionId = sessionId;
    this.#items = items.map(cloneMediaItem);
    this.#fingerprints = items.map(layoutFingerprint);
    this.#deferredMedia = nextDeferred;
  }
}

type VisualProjection =
  | { kind: "visual"; width: number; height: number }
  | { kind: "deferred"; reason: DeferredMediaReason };

function projectVisual(item: MediaItem): VisualProjection {
  if (item.visual === null) {
    return { kind: "deferred", reason: "missing-visual" };
  }

  if (
    !Number.isFinite(item.visual.width) ||
    item.visual.width <= 0 ||
    !Number.isFinite(item.visual.height) ||
    item.visual.height <= 0
  ) {
    return { kind: "deferred", reason: "invalid-visual" };
  }

  return {
    kind: "visual",
    width: item.visual.width,
    height: item.visual.height,
  };
}

function layoutFingerprint(item: MediaItem): string {
  if (item.visual === null) {
    return `${item.id}:missing`;
  }
  return `${item.id}:${item.visual.width}:${item.visual.height}`;
}

function prefixEquals(
  previous: readonly string[],
  next: readonly string[],
): boolean {
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }
  return true;
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

function sameConfig(
  left: MasonryLayoutConfig,
  right: MasonryLayoutConfig,
): boolean {
  return (
    left.viewport.width === right.viewport.width &&
    left.viewport.height === right.viewport.height &&
    left.columnCount === right.columnCount &&
    left.gap === right.gap
  );
}

function cloneConfig(config: MasonryLayoutConfig): MasonryLayoutConfig {
  return {
    viewport: { ...config.viewport },
    columnCount: config.columnCount,
    gap: config.gap,
  };
}

function cloneMediaItem(item: MediaItem): MediaItem {
  return {
    ...item,
    visual: item.visual === null ? null : { ...item.visual },
  };
}
