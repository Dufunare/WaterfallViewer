import { invoke } from "@tauri-apps/api/core";

import type {
  MediaRepresentationPort,
  ThumbnailRepresentation,
  ThumbnailRequest,
} from "../../application/ports/mediaRepresentation";

let nextThumbnailRequestSequence = 0;

export class TauriMediaRepresentationPort implements MediaRepresentationPort {
  async requestThumbnail(
    request: ThumbnailRequest,
    signal?: AbortSignal,
  ): Promise<ThumbnailRepresentation> {
    if (request.resourceKey.trim().length === 0) {
      throw new RangeError("resourceKey must not be empty");
    }
    if (!Number.isInteger(request.maxEdge) || request.maxEdge <= 0) {
      throw new RangeError("maxEdge must be a positive integer");
    }
    if (signal?.aborted) {
      throw new Error("thumbnail request was cancelled");
    }

    const requestId = nextThumbnailRequestId();
    let cancellationSent = false;
    const cancelBackend = () => {
      if (cancellationSent) {
        return;
      }
      cancellationSent = true;
      void invoke<boolean>("cancel_thumbnail_request", { requestId }).catch(
        () => undefined,
      );
    };

    signal?.addEventListener("abort", cancelBackend, { once: true });
    try {
      // Re-check after installing the listener so an abort racing with invoke
      // becomes either an immediate frontend cancellation or a backend
      // pre-cancellation tombstone.
      if (signal?.aborted) {
        cancelBackend();
        throw new Error("thumbnail request was cancelled");
      }

      return await invoke<ThumbnailRepresentation>("request_thumbnail", {
        requestId,
        resourceKey: request.resourceKey,
        maxEdge: request.maxEdge,
      });
    } finally {
      signal?.removeEventListener("abort", cancelBackend);
    }
  }

  async releaseRepresentation(resourceKey: string): Promise<void> {
    if (resourceKey.trim().length === 0) {
      throw new RangeError("resourceKey must not be empty");
    }
    await invoke<boolean>("release_representation", { resourceKey });
  }
}

function nextThumbnailRequestId(): string {
  nextThumbnailRequestSequence += 1;
  return `thumbnail-${Date.now().toString(36)}-${nextThumbnailRequestSequence.toString(36)}`;
}

export const tauriMediaRepresentationPort = new TauriMediaRepresentationPort();
