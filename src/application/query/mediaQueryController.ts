import { MediaSessionController } from "../mediaSession";
import type { MediaItem, MediaKind } from "../ports/mediaScan";

export const ALL_MEDIA_KINDS: readonly MediaKind[] = [
  "image",
  "animated-image",
  "video",
  "audio",
];

export interface MediaQuerySnapshot {
  sessionId: string | null;
  includedKinds: readonly MediaKind[];
  sourceItemCount: number;
  matchedItemCount: number;
  /**
   * Changes only when the projection must be rebuilt instead of incrementally
   * appended. Consumers can use this to preserve O(batch) streaming updates.
   */
  projectionRevision: number;
}

export type MediaQueryListener = (snapshot: MediaQuerySnapshot) => void;

/**
 * Shared source-order projection over the active media session.
 *
 * The projection stores only media ids. Appending a scan batch therefore costs
 * O(batch), while changing the query deliberately rebuilds the projection once.
 * Layout, canvas, and viewer navigation can all consume this same order without
 * owning duplicate filtering policy.
 */
export class MediaQueryController {
  readonly #sessionController: MediaSessionController;
  readonly #listeners = new Set<MediaQueryListener>();
  readonly #unsubscribeSession: () => void;
  readonly #ids: string[] = [];
  readonly #indexById = new Map<string, number>();

  #includedKinds = new Set<MediaKind>(ALL_MEDIA_KINDS);
  #lastSessionId: string | null = null;
  #lastSourceItemCount = 0;
  #lastReplacementRevision = 0;
  #projectionRevision = 0;
  #disposed = false;

  constructor(sessionController: MediaSessionController) {
    this.#sessionController = sessionController;
    this.#unsubscribeSession = sessionController.subscribe(() => {
      this.#handleSessionChange();
    });
  }

  get snapshot(): MediaQuerySnapshot {
    const session = this.#sessionController.current;
    return {
      sessionId: session?.id ?? null,
      includedKinds: ALL_MEDIA_KINDS.filter((kind) => this.#includedKinds.has(kind)),
      sourceItemCount: session?.items.size ?? 0,
      matchedItemCount: this.#ids.length,
      projectionRevision: this.#projectionRevision,
    };
  }

  get size(): number {
    return this.#ids.length;
  }

  subscribe(listener: MediaQueryListener): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  includes(kind: MediaKind): boolean {
    return this.#includedKinds.has(kind);
  }

  setIncludedKinds(kinds: readonly MediaKind[]): void {
    this.#assertActive();
    const next = normalizeKinds(kinds);
    if (sameKindSet(this.#includedKinds, next)) {
      return;
    }

    this.#includedKinds = next;
    const session = this.#sessionController.current;
    if (session === null) {
      this.#ids.length = 0;
      this.#indexById.clear();
      this.#projectionRevision += 1;
    } else {
      this.#rebuild(session.items.values());
      this.#lastSessionId = session.id;
      this.#lastSourceItemCount = session.items.size;
      this.#lastReplacementRevision = session.items.replacementRevision;
    }
    this.#publish();
  }

  reset(): void {
    this.setIncludedKinds(ALL_MEDIA_KINDS);
  }

  get(id: string): MediaItem | undefined {
    if (!this.#indexById.has(id)) {
      return undefined;
    }
    return this.#sessionController.current?.items.get(id);
  }

  at(index: number): MediaItem | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.#ids.length) {
      return undefined;
    }
    const id = this.#ids[index];
    return this.#sessionController.current?.items.get(id);
  }

  indexOf(id: string): number {
    return this.#indexById.get(id) ?? -1;
  }

  ids(): readonly string[] {
    return [...this.#ids];
  }

  values(): readonly MediaItem[] {
    const items = this.#sessionController.current?.items;
    if (items === undefined) {
      return [];
    }
    return this.#ids.flatMap((id) => {
      const item = items.get(id);
      return item === undefined ? [] : [item];
    });
  }

  valuesFrom(startIndex: number): readonly MediaItem[] {
    if (
      !Number.isInteger(startIndex) ||
      startIndex < 0 ||
      startIndex > this.#ids.length
    ) {
      throw new RangeError("startIndex must be an integer within the query projection");
    }

    const items = this.#sessionController.current?.items;
    if (items === undefined) {
      return [];
    }
    return this.#ids.slice(startIndex).flatMap((id) => {
      const item = items.get(id);
      return item === undefined ? [] : [item];
    });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribeSession();
    this.#listeners.clear();
    this.#ids.length = 0;
    this.#indexById.clear();
  }

  #handleSessionChange(): void {
    if (this.#disposed) {
      return;
    }

    const session = this.#sessionController.current;
    if (session === null) {
      if (this.#lastSessionId !== null || this.#ids.length > 0) {
        this.#ids.length = 0;
        this.#indexById.clear();
        this.#projectionRevision += 1;
      }
      this.#lastSessionId = null;
      this.#lastSourceItemCount = 0;
      this.#lastReplacementRevision = 0;
      this.#publish();
      return;
    }

    const sourceItemCount = session.items.size;
    const replacementRevision = session.items.replacementRevision;
    if (
      session.id !== this.#lastSessionId ||
      sourceItemCount < this.#lastSourceItemCount ||
      replacementRevision !== this.#lastReplacementRevision
    ) {
      this.#rebuild(session.items.values());
    } else if (sourceItemCount > this.#lastSourceItemCount) {
      this.#append(session.items.valuesFrom(this.#lastSourceItemCount));
    }

    this.#lastSessionId = session.id;
    this.#lastSourceItemCount = sourceItemCount;
    this.#lastReplacementRevision = replacementRevision;
    this.#publish();
  }

  #rebuild(items: readonly MediaItem[]): void {
    this.#ids.length = 0;
    this.#indexById.clear();
    this.#append(items);
    this.#projectionRevision += 1;
  }

  #append(items: readonly MediaItem[]): void {
    for (const item of items) {
      if (!this.#includedKinds.has(item.kind) || this.#indexById.has(item.id)) {
        continue;
      }
      const index = this.#ids.length;
      this.#ids.push(item.id);
      this.#indexById.set(item.id, index);
    }
  }

  #publish(): void {
    const snapshot = this.snapshot;
    for (const listener of [...this.#listeners]) {
      listener(snapshot);
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("media query controller is disposed");
    }
  }
}

function normalizeKinds(kinds: readonly MediaKind[]): Set<MediaKind> {
  const next = new Set<MediaKind>();
  for (const kind of kinds) {
    if (!ALL_MEDIA_KINDS.includes(kind)) {
      throw new RangeError(`unsupported media kind: ${String(kind)}`);
    }
    next.add(kind);
  }
  return next;
}

function sameKindSet(left: ReadonlySet<MediaKind>, right: ReadonlySet<MediaKind>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const kind of left) {
    if (!right.has(kind)) {
      return false;
    }
  }
  return true;
}
