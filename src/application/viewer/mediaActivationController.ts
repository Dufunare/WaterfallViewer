import { MediaSessionController } from "../mediaSession";
import type { MediaResourcePort } from "../ports/mediaResource";
import type { MediaKind } from "../ports/mediaScan";

export interface ActiveMediaSnapshot {
  sessionId: string;
  mediaId: string;
  name: string;
  relativePath: string;
  kind: MediaKind;
  uri: string;
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
 */
export class MediaActivationController {
  readonly #sessionController: MediaSessionController;
  readonly #resourcePort: MediaResourcePort;
  readonly #listeners = new Set<MediaActivationListener>();
  readonly #unsubscribeSession: () => void;

  #snapshot: ActiveMediaSnapshot | null = null;
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
    const media = session?.items.get(mediaId);
    if (session === null || media === undefined) {
      return false;
    }

    const next: ActiveMediaSnapshot = {
      sessionId: session.id,
      mediaId: media.id,
      name: media.name,
      relativePath: media.relativePath,
      kind: media.kind,
      uri: this.#resourcePort.uriFor(media.resourceKey),
    };
    if (sameSnapshot(this.#snapshot, next)) {
      return true;
    }

    this.#snapshot = next;
    this.#publish();
    return true;
  }

  clear(): void {
    this.#assertActive();
    if (this.#snapshot === null) {
      return;
    }
    this.#snapshot = null;
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
  }

  #reconcile(): void {
    if (this.#disposed || this.#snapshot === null) {
      return;
    }

    const session = this.#sessionController.current;
    if (session === null || session.id !== this.#snapshot.sessionId) {
      this.#snapshot = null;
      this.#publish();
      return;
    }

    const media = session.items.get(this.#snapshot.mediaId);
    if (media === undefined) {
      this.#snapshot = null;
      this.#publish();
      return;
    }

    const next: ActiveMediaSnapshot = {
      sessionId: session.id,
      mediaId: media.id,
      name: media.name,
      relativePath: media.relativePath,
      kind: media.kind,
      uri: this.#resourcePort.uriFor(media.resourceKey),
    };
    if (!sameSnapshot(this.#snapshot, next)) {
      this.#snapshot = next;
      this.#publish();
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
    left.uri === right.uri
  );
}
