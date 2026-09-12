import type { MediaItem } from "../ports/mediaScan";
import {
  JustifiedLayoutBuilder,
  type JustifiedLayoutConfig,
  type JustifiedLayoutNode,
  type JustifiedLayoutResult,
} from "../../layout/justified/justifiedLayout";
import {
  VerticalViewportIndex,
  type ViewportQueryOptions,
  type ViewportRect,
} from "../../layout/viewport/verticalViewportIndex";

export type JustifiedDeferredMediaReason = "missing-visual" | "invalid-visual";

export interface JustifiedDeferredMedia {
  mediaId: string;
  reason: JustifiedDeferredMediaReason;
}

export interface JustifiedFlowSnapshot {
  sessionId: string | null;
  itemCount: number;
  layoutItemCount: number;
  deferredMedia: readonly JustifiedDeferredMedia[];
  terminal: boolean;
  layout: JustifiedLayoutResult;
}

/**
 * Application projection for streaming justified rows.
 *
 * Full rows are indexed immediately. The unfinished tail remains outside the
 * viewport index until `markTerminal` is called, preventing previously emitted
 * geometry from moving while a scan is still streaming.
 */
export class JustifiedFlowModel {
  #config: JustifiedLayoutConfig;
  #builder: JustifiedLayoutBuilder;
  #viewportIndex = new VerticalViewportIndex<JustifiedLayoutNode>();
  #sessionId: string | null = null;
  #items: MediaItem[] = [];
  #fingerprints: string[] = [];
  #deferredMedia: JustifiedDeferredMedia[] = [];
  readonly #mediaIds = new Set<string>();
  #terminal = false;

  constructor(config: JustifiedLayoutConfig) {
    this.#builder = new JustifiedLayoutBuilder(config);
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

  get pendingCount(): number {
    return this.#builder.pendingCount;
  }

  get terminal(): boolean {
    return this.#terminal;
  }

  configure(config: JustifiedLayoutConfig): void {
    if (sameConfig(this.#config, config)) {
      return;
    }
    this.#rebuild(this.#sessionId, this.#items, config, this.#terminal);
  }

  append(sessionId: string, items: readonly MediaItem[]): void {
    if (sessionId.trim().length === 0) {
      throw new RangeError("sessionId must not be empty");
    }
    if (this.#sessionId !== sessionId) {
      throw new Error("append session must match the active flow session");
    }
    if (this.#terminal) {
      throw new Error("cannot append media after justified flow is terminal");
    }
    validateAppendBatch(items, this.#mediaIds);
    if (items.length === 0) {
      return;
    }

    this.#appendItems(items);
    for (const item of items) {
      this.#items.push(cloneMediaItem(item));
      this.#fingerprints.push(layoutFingerprint(item));
      this.#mediaIds.add(item.id);
    }
  }

  sync(
    sessionId: string,
    items: readonly MediaItem[],
    terminal = false,
  ): void {
    if (sessionId.trim().length === 0) {
      throw new RangeError("sessionId must not be empty");
    }
    validateUniqueIds(items);

    const nextFingerprints = items.map(layoutFingerprint);
    const canAppend =
      this.#sessionId === sessionId &&
      !this.#terminal &&
      this.#fingerprints.length <= nextFingerprints.length &&
      prefixEquals(this.#fingerprints, nextFingerprints);

    if (!canAppend) {
      const sameState =
        this.#sessionId === sessionId &&
        this.#terminal === terminal &&
        arraysEqual(this.#fingerprints, nextFingerprints);
      if (!sameState) {
        this.#rebuild(sessionId, items, this.#config, terminal);
      }
      return;
    }

    const previousLength = this.#items.length;
    const addedItems = items.slice(previousLength);
    if (addedItems.length > 0) {
      this.append(sessionId, addedItems);
    }
    if (terminal) {
      this.markTerminal();
    }
  }

  markTerminal(): void {
    if (this.#terminal) {
      return;
    }
    this.#terminal = true;
    const nodes = this.#builder.flushPending();
    this.#viewportIndex.append(nodes);
  }

  queryVisible(
    viewport: ViewportRect,
    options: ViewportQueryOptions = {},
  ): readonly JustifiedLayoutNode[] {
    return this.#viewportIndex.query(viewport, options);
  }

  snapshot(): JustifiedFlowSnapshot {
    return {
      sessionId: this.#sessionId,
      itemCount: this.#items.length,
      layoutItemCount: this.#builder.size,
      deferredMedia: this.#deferredMedia.map((item) => ({ ...item })),
      terminal: this.#terminal,
      layout: this.#builder.snapshot(),
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

    const nodes = this.#builder.append(visualItems);
    this.#viewportIndex.append(nodes);
  }

  #rebuild(
    sessionId: string | null,
    items: readonly MediaItem[],
    config: JustifiedLayoutConfig,
    terminal: boolean,
  ): void {
    const nextBuilder = new JustifiedLayoutBuilder(config);
    const nextViewportIndex = new VerticalViewportIndex<JustifiedLayoutNode>();
    const nextDeferred: JustifiedDeferredMedia[] = [];
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

    nextViewportIndex.append(nextBuilder.append(visualItems));
    if (terminal) {
      nextViewportIndex.append(nextBuilder.flushPending());
    }

    this.#config = cloneConfig(config);
    this.#builder = nextBuilder;
    this.#viewportIndex = nextViewportIndex;
    this.#sessionId = sessionId;
    this.#items = items.map(cloneMediaItem);
    this.#fingerprints = items.map(layoutFingerprint);
    this.#deferredMedia = nextDeferred;
    this.#terminal = terminal;
    this.#mediaIds.clear();
    for (const item of items) {
      this.#mediaIds.add(item.id);
    }
  }
}

type VisualProjection =
  | { kind: "visual"; width: number; height: number }
  | { kind: "deferred"; reason: JustifiedDeferredMediaReason };

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

function validateUniqueIds(items: readonly MediaItem[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    validateMediaId(item.id);
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
    validateMediaId(item.id);
    if (existingIds.has(item.id) || batchIds.has(item.id)) {
      throw new RangeError(`duplicate media id: ${item.id}`);
    }
    batchIds.add(item.id);
  }
}

function validateMediaId(id: string): void {
  if (id.trim().length === 0) {
    throw new RangeError("media id must not be empty");
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

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && prefixEquals(left, right);
}

function sameConfig(
  left: JustifiedLayoutConfig,
  right: JustifiedLayoutConfig,
): boolean {
  return (
    left.viewport.width === right.viewport.width &&
    left.viewport.height === right.viewport.height &&
    left.targetRowHeight === right.targetRowHeight &&
    left.gap === right.gap
  );
}

function cloneConfig(config: JustifiedLayoutConfig): JustifiedLayoutConfig {
  return {
    viewport: { ...config.viewport },
    targetRowHeight: config.targetRowHeight,
    gap: config.gap,
  };
}

function cloneMediaItem(item: MediaItem): MediaItem {
  return {
    ...item,
    visual: item.visual === null ? null : { ...item.visual },
  };
}
