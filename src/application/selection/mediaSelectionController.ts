import type { MediaSession, MediaSessionController } from "../mediaSession";

export interface MediaSelectionSnapshot {
  sessionId: string | null;
  selectedIds: readonly string[];
  primaryId: string | null;
}

export type MediaSelectionListener = (snapshot: MediaSelectionSnapshot) => void;

/**
 * Session-scoped media selection shared by Flow and Canvas views.
 *
 * Selection survives query/filter/sort projection changes within the same
 * media session and is cleared only when the source session is replaced.
 */
export class MediaSelectionController {
  readonly #sessionController: MediaSessionController;
  readonly #listeners = new Set<MediaSelectionListener>();
  readonly #unsubscribeSession: () => void;
  readonly #selectedIds = new Set<string>();

  #sessionId: string | null = null;
  #primaryId: string | null = null;
  #disposed = false;

  constructor(sessionController: MediaSessionController) {
    this.#sessionController = sessionController;
    this.#unsubscribeSession = sessionController.subscribe((session) => {
      this.#handleSessionChange(session);
    });
  }

  get snapshot(): MediaSelectionSnapshot {
    return this.#buildSnapshot();
  }

  subscribe(listener: MediaSelectionListener): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    listener(this.#buildSnapshot());
    return () => {
      this.#listeners.delete(listener);
    };
  }

  replace(mediaId: string): boolean {
    this.#assertActive();
    if (!this.#isSelectable(mediaId)) {
      return false;
    }
    if (this.#selectedIds.size === 1 && this.#selectedIds.has(mediaId)) {
      return false;
    }

    this.#selectedIds.clear();
    this.#selectedIds.add(mediaId);
    this.#primaryId = mediaId;
    this.#publish();
    return true;
  }

  toggle(mediaId: string): boolean {
    this.#assertActive();
    if (!this.#isSelectable(mediaId)) {
      return false;
    }

    if (this.#selectedIds.delete(mediaId)) {
      if (this.#primaryId === mediaId) {
        this.#primaryId = lastValue(this.#selectedIds);
      }
    } else {
      this.#selectedIds.add(mediaId);
      this.#primaryId = mediaId;
    }
    this.#publish();
    return true;
  }

  clear(): boolean {
    this.#assertActive();
    if (this.#selectedIds.size === 0) {
      return false;
    }
    this.#selectedIds.clear();
    this.#primaryId = null;
    this.#publish();
    return true;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribeSession();
    this.#listeners.clear();
  }

  #handleSessionChange(session: MediaSession | null): void {
    if (this.#disposed) {
      return;
    }
    const sessionId = session?.id ?? null;
    if (sessionId === this.#sessionId) {
      return;
    }

    this.#sessionId = sessionId;
    this.#selectedIds.clear();
    this.#primaryId = null;
    this.#publish();
  }

  #isSelectable(mediaId: string): boolean {
    if (mediaId.trim().length === 0) {
      return false;
    }
    const session = this.#sessionController.current;
    return session !== null && session.id === this.#sessionId && session.items.has(mediaId);
  }

  #buildSnapshot(): MediaSelectionSnapshot {
    return {
      sessionId: this.#sessionId,
      selectedIds: [...this.#selectedIds],
      primaryId: this.#primaryId,
    };
  }

  #publish(): void {
    if (this.#disposed) {
      return;
    }
    const snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("media selection controller is disposed");
    }
  }
}

function lastValue(values: ReadonlySet<string>): string | null {
  let last: string | null = null;
  for (const value of values) {
    last = value;
  }
  return last;
}
