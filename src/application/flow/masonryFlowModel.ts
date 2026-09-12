import {
  mediaVisualFingerprint,
  projectMediaVisual,
  type MediaVisualDeferredReason,
} from "../mediaVisualProjection";
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

export type DeferredMediaReason = MediaVisualDeferredReason;

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
 * The common scan path can call `append` with only the newly arrived batch,
 * keeping layout and viewport indexing O(batch). `sync` remains the defensive
 * full-state reconciliation path for replacements, reordering, session
 * changes, or callers that do not have append information.
 */
export class MasonryFlowModel {
  #config: MasonryLayoutConfig;
  #builder: MasonryLayoutBuilder;
  #viewportIndex = new VerticalViewportIndex<MasonryLayoutNode>();
  #sessionId: string | null = null;
  #items: MediaItem[] = [];
  #fingerprints: string[] = [];
  #deferredMedia: DeferredMedia[] = [];
  readonly #mediaIds = new Set<string>();

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

  get layoutItemCount(): number {
    return this.#builder.size;
  }

  get deferredCount(): number {
    return this.#deferredMedia.length;
  }

  get totalHeight(): number {
    return this.#builder.totalHeight;
  }

  get columnWidth(): number {
    return this.#builder.columnWidth;
  }

  configure(config: MasonryLayoutConfig): void {
    if (sameConfig(this.#config, config)) {
      return;
    }

    this.#rebuild(this.#sessionId, this.#items, config);
  }

  append(sessionId: string, items: readonly MediaItem[]): void {
    if (sessionId.trim().length === 0) {
      throw new RangeError("sessionId must not be empty");
    }
    if (this.#sessionId !== sessionId) {
      throw new Error("append session must match the active flow session");
    }
    validateAppendBatch(items, this.#mediaIds);
    if (items.length === 0) {
      return;
    }

    this.#appendItems(items);
    for (const item of items) {
      this.#items.push(cloneMediaItem(item));
      this.#fingerprints.push(mediaVisualFingerprint(item));
      this.#mediaIds.add(item.id);
    }
  }

  sync(sessionId: string, items: readonly MediaItem[]): void {
    if (sessionId.trim().length === 0) {
      throw new RangeError("sessionId must not be empty");
    }
    validateUniqueIds(items);

    const nextFingerprints = items.map(mediaVisualFingerprint);
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
      this.append(sessionId, addedItems);
    }
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
      const projection = projectMediaVisual(item);
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
      const projection = projectMediaVisual(item);
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
    this.#fingerprints = items.map(mediaVisualFingerprint);
    this.#deferredMedia = nextDeferred;
    this.#mediaIds.clear();
    for (const item of items) {
      this.#mediaIds.add(item.id);
    }
  }
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

function validateAppendBatch(
  items: readonly MediaItem[],
  existingIds: ReadonlySet<string>,
): void {
  const batchIds = new Set<string>();
  for (const item of items) {
    if (item.id.trim().length === 0) {
      throw new RangeError("media id must not be empty");
    }
    if (existingIds.has(item.id) || batchIds.has(item.id)) {
      throw new RangeError(`duplicate media id: ${item.id}`);
    }
    batchIds.add(item.id);
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
