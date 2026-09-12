import { invoke } from "@tauri-apps/api/core";

import type {
  MediaRepresentationPort,
  ThumbnailRepresentation,
  ThumbnailRequest,
} from "../../application/ports/mediaRepresentation";

export class TauriMediaRepresentationPort implements MediaRepresentationPort {
  async requestThumbnail(
    request: ThumbnailRequest,
  ): Promise<ThumbnailRepresentation> {
    if (request.resourceKey.trim().length === 0) {
      throw new RangeError("resourceKey must not be empty");
    }
    if (!Number.isInteger(request.maxEdge) || request.maxEdge <= 0) {
      throw new RangeError("maxEdge must be a positive integer");
    }

    return invoke<ThumbnailRepresentation>("request_thumbnail", {
      resourceKey: request.resourceKey,
      maxEdge: request.maxEdge,
    });
  }
}

export const tauriMediaRepresentationPort = new TauriMediaRepresentationPort();
