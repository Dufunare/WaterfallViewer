import { MediaSessionController } from "../mediaSession";
import type { MediaResourcePort } from "../ports/mediaResource";
import type { MediaItem, MediaKind } from "../ports/mediaScan";

export interface ActiveMediaSnapshot {
  sessionId: string;
  mediaId: string;
  name: string;
  relativePath: string;
  kind: MediaKind;
  uri: string;
  position: number;
  totalItems: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export type MediaActivationListener = (
  snapshot: ActiveMediaSnapshot | null,
) => void;

/**
 * Shared explicit media activation state for all viewer modes.
 *
 * Browsing stays lightweight: activating one item resolves its original media
 * URI only on demand. Session replacement automatically invalidates stale
 * activation so an overlay can never keep a resource handle from an old source.
 * Adjacent navigation follows the stable scan order and still resolves only the
 * single item that becomes active.
 */
export class MediaActivationController {
  readonly #sessionController: MediaSessionController;
  readonly #resourcePort: MediaResourcePort;
  readonly #listeners = new Set<MediaActivationListener>();
  readonly #unsubscribeSession: () => void;

  #snapshot: ActiveMediaSnapshot | null = null;
  #activeIndex: number | null = null;
  #disposed = false;

  constructor(
    sessionController: MediaSessionController,
    resourcePort: MediaResourcePort,
  ) {
    this.#sessionController = sessionController;
    this.#resourcePort = resourcePort;
    this.#unsubscribeSession = sessionController.subscribe(() => {
      this.#reconcile();
    });
  }

  get snapshot(): ActiveMediaSnapshot | null {
    return this.#snapshot === null ? null : { ...this.#snapshot };
  }

  subscribe(listener: MediaActivationListener): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  activate(mediaId: string): boolean {
    this.#assertActive();
    if (mediaId.trim().length === 0) {
      throw new RangeError("mediaId must not be empty");
    }

    const session = this.#sessionController.current;
    if (session === null) {
      return false;
    }

    const index = session.items.indexOf(mediaId);
    if (index < 0) {
      return false;
    }
    return this.#activateIndex(index);
  }

  activatePrevious(): boolean {
    this.#assertActive();
    if (this.#activeIndex === null || this.#snapshot === null) {
      return false;
    }
    const session = this.#sessionController.current;
    if (session === null || session.id !== this.#snapshot.sessionId) {
      return false;
    }
    return this.#activateIndex(this.#activeIndex - 1);
  }

  activateNext(): boolean {
    this.#assertActive();
    if (this.#activeIndex === null || this.#snapshot === null) {
      return false;
    }
    const session = this.#sessionController.current;
    if (session === null || session.id !== this.#snapshot.sessionId) {
      return false;
    }
    return this.#activateIndex(this.#activeIndex + 1);
  }

  clear(): void {
    this.#assertActive();
    if (this.#snapshot === null) {
      return;
    }
    this.#snapshot = null;
    this.#activeIndex = null;
    this.#publish();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribeSession();
    this.#listeners.clear();
    this.#snapshot = null;
    this.#activeIndex = null;
  }

  #activateIndex(index: number): boolean {
    const session = this.#sessionController.current;
    const media = session?.items.at(index);
    if (session === null || media === undefined) {
      return false;
    }

    const next = this.#buildSnapshot(session.id, index, session.items.size, media);
    this.#activeIndex = index;
    if (sameSnapshot(this.#snapshot, next)) {
      return true;
    }

    this.#snapshot = next;
    this.#publish();
    return true;
  }

  #buildSnapshot(
    sessionId: string,
    index: number,
    totalItems: number,
    media: MediaItem,
  ): ActiveMediaSnapshot {
    return {
      sessionId,
      mediaId: media.id,
      name: media.name,
      relativePath: media.relativePath,
      kind: media.kind,
      uri: this.#resourcePort.uriFor(media.resourceKey),
      position: index + 1,
      totalItems,
      hasPrevious: index > 0,
      hasNext: index + 1 < totalItems,
    };
  }

  #reconcile(): void {
    if (this.#disposed || this.#snapshot === null) {
      return;
    }

    const session = this.#sessionController.current;
    if (session === null || session.id !== this.#snapshot.sessionId) {
      this.#clearFromSessionChange();
      return;
    }

    let index = this.#activeIndex;
    let media = index === null ? undefined : session.items.at(index);
    if (media?.id !== this.#snapshot.mediaId) {
      index = session.items.indexOf(this.#snapshot.mediaId);
      media = index < 0 ? undefined : session.items.at(index);
    }
    if (index === null || index < 0 || media === undefined) {
      this.#clearFromSessionChange();
      return;
    }

    const next = this.#buildSnapshot(session.id, index, session.items.size, media);
    this.#activeIndex = index;
    if (!sameSnapshot(this.#snapshot, next)) {
      this.#snapshot = next;
      this.#publish();
    }
  }

  #clearFromSessionChange(): void {
    this.#snapshot = null;
    this.#activeIndex = null;
    this.#publish();
  }

  #publish(): void {
    const snapshot = this.snapshot;
    for (const listener of [...this.#listeners]) {
      listener(snapshot);
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("media activation controller is disposed");
    }
  }
}

function sameSnapshot(
  left: ActiveMediaSnapshot | null,
  right: ActiveMediaSnapshot | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  return (
    left.sessionId === right.sessionId &&
    left.mediaId === right.mediaId &&
    left.name === right.name &&
    left.relativePath === right.relativePath &&
    left.kind === right.kind &&
    left.uri === right.uri &&
    left.position === right.position &&
    left.totalItems === right.totalItems &&
    left.hasPrevious === right.hasPrevious &&
    left.hasNext === right.hasNext
  );
}
