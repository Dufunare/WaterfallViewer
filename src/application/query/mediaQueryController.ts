import {
  ALL_MEDIA_KINDS,
  MediaSessionController,
  type MediaSort,
} from "../mediaSession";
import type { MediaKind } from "../ports/mediaScan";

export { ALL_MEDIA_KINDS } from "../mediaSession";
export type { MediaSort } from "../mediaSession";

export interface MediaQuerySnapshot {
  sessionId: string | null;
  includedKinds: readonly MediaKind[];
  sourceItemCount: number;
  matchedItemCount: number;
  projectionRevision: number;
  sort: MediaSort;
  effectiveSort: MediaSort;
  sortPending: boolean;
}

export type MediaQueryListener = (snapshot: MediaQuerySnapshot) => void;

/**
 * Application-level owner for the active media query.
 *
 * `MediaIndex` retains the complete scan result and exposes the filtered/sorted
 * projection. Sorting is intentionally deferred while a scan is active so batch
 * delivery stays append-only; the requested sort is applied once the scan reaches
 * a terminal state.
 */
export class MediaQueryController {
  readonly #sessionController: MediaSessionController;
  readonly #listeners = new Set<MediaQueryListener>();
  readonly #unsubscribeSession: () => void;
  #disposed = false;

  constructor(sessionController: MediaSessionController) {
    this.#sessionController = sessionController;
    this.#unsubscribeSession = sessionController.subscribe(() => {
      this.#publish();
    });
  }

  get snapshot(): MediaQuerySnapshot {
    const session = this.#sessionController.current;
    const sort = this.#sessionController.sort;
    const effectiveSort = session?.items.sort ?? "source";
    return {
      sessionId: session?.id ?? null,
      includedKinds: this.#sessionController.includedKinds,
      sourceItemCount: session?.items.sourceSize ?? 0,
      matchedItemCount: session?.items.size ?? 0,
      projectionRevision: session?.items.projectionRevision ?? 0,
      sort,
      effectiveSort,
      sortPending: session !== null && sort !== effectiveSort,
    };
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
    return this.#sessionController.includedKinds.includes(kind);
  }

  setIncludedKinds(kinds: readonly MediaKind[]): boolean {
    this.#assertActive();
    const hadSession = this.#sessionController.current !== null;
    const changed = this.#sessionController.setIncludedKinds(kinds);
    if (changed && !hadSession) {
      this.#publish();
    }
    return changed;
  }

  reset(): boolean {
    return this.setIncludedKinds(ALL_MEDIA_KINDS);
  }

  setSort(sort: MediaSort): boolean {
    this.#assertActive();
    const hadSession = this.#sessionController.current !== null;
    const changed = this.#sessionController.setSort(sort);
    if (changed && !hadSession) {
      this.#publish();
    }
    return changed;
  }

  resetSort(): boolean {
    return this.setSort("source");
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribeSession();
    this.#listeners.clear();
  }

  #publish(): void {
    if (this.#disposed) {
      return;
    }
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
