import type { MediaDetail, MediaDetailPort } from "../ports/mediaDetail";
import type {
  ActiveMediaSnapshot,
  MediaActivationListener,
} from "./mediaActivationController";

export type PreviewMediaDetailStatus = "idle" | "loading" | "ready" | "error";

export interface PreviewMediaDetailSnapshot {
  mediaId: string | null;
  status: PreviewMediaDetailStatus;
  detail: MediaDetail | null;
  error: string | null;
}

export type PreviewMediaDetailListener = (
  snapshot: PreviewMediaDetailSnapshot,
) => void;

export interface MediaActivationSource {
  readonly snapshot: ActiveMediaSnapshot | null;
  subscribe(listener: MediaActivationListener): () => void;
}

/**
 * Loads richer metadata only for the currently active video/audio item.
 *
 * Activation/navigation stays synchronous and independent from metadata I/O.
 * A monotonically increasing request revision prevents slow results from a
 * previously active item from overwriting the current preview state.
 */
export class PreviewMediaDetailController {
  readonly #activation: MediaActivationSource;
  readonly #detailPort: MediaDetailPort;
  readonly #listeners = new Set<PreviewMediaDetailListener>();
  readonly #unsubscribeActivation: () => void;

  #snapshot: PreviewMediaDetailSnapshot = idleSnapshot();
  #requestRevision = 0;
  #disposed = false;

  constructor(activation: MediaActivationSource, detailPort: MediaDetailPort) {
    this.#activation = activation;
    this.#detailPort = detailPort;
    this.#unsubscribeActivation = activation.subscribe((active) => {
      this.#onActivationChanged(active);
    });
  }

  get snapshot(): PreviewMediaDetailSnapshot {
    return cloneSnapshot(this.#snapshot);
  }

  subscribe(listener: PreviewMediaDetailListener): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#requestRevision += 1;
    this.#unsubscribeActivation();
    this.#listeners.clear();
    this.#snapshot = idleSnapshot();
  }

  #onActivationChanged(active: ActiveMediaSnapshot | null): void {
    if (this.#disposed) {
      return;
    }

    const revision = ++this.#requestRevision;
    if (
      active === null ||
      active.kind === "image" ||
      active.kind === "animated-image"
    ) {
      this.#setSnapshot(idleSnapshot());
      return;
    }

    this.#setSnapshot({
      mediaId: active.mediaId,
      status: "loading",
      detail: null,
      error: null,
    });

    void this.#detailPort
      .getDetail({ resourceKey: active.resourceKey, kind: active.kind })
      .then((detail) => {
        if (!this.#isCurrentRequest(revision, active.mediaId)) {
          return;
        }
        this.#setSnapshot({
          mediaId: active.mediaId,
          status: "ready",
          detail,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!this.#isCurrentRequest(revision, active.mediaId)) {
          return;
        }
        this.#setSnapshot({
          mediaId: active.mediaId,
          status: "error",
          detail: null,
          error: errorMessage(error),
        });
      });
  }

  #isCurrentRequest(revision: number, mediaId: string): boolean {
    return (
      !this.#disposed &&
      revision === this.#requestRevision &&
      this.#activation.snapshot?.mediaId === mediaId
    );
  }

  #setSnapshot(next: PreviewMediaDetailSnapshot): void {
    if (sameSnapshot(this.#snapshot, next)) {
      return;
    }
    this.#snapshot = next;
    const snapshot = this.snapshot;
    for (const listener of [...this.#listeners]) {
      listener(snapshot);
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("preview media detail controller is disposed");
    }
  }
}

function idleSnapshot(): PreviewMediaDetailSnapshot {
  return { mediaId: null, status: "idle", detail: null, error: null };
}

function cloneSnapshot(snapshot: PreviewMediaDetailSnapshot): PreviewMediaDetailSnapshot {
  return {
    ...snapshot,
    detail: snapshot.detail === null ? null : { ...snapshot.detail },
  };
}

function sameSnapshot(
  left: PreviewMediaDetailSnapshot,
  right: PreviewMediaDetailSnapshot,
): boolean {
  return (
    left.mediaId === right.mediaId &&
    left.status === right.status &&
    left.detail === right.detail &&
    left.error === right.error
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
