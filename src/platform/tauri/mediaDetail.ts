import { invoke } from "@tauri-apps/api/core";

import type {
  MediaDetail,
  MediaDetailPort,
  MediaDetailRequest,
} from "../../application/ports/mediaDetail";

export class TauriMediaDetailPort implements MediaDetailPort {
  async getDetail(request: MediaDetailRequest): Promise<MediaDetail | null> {
    if (request.resourceKey.trim().length === 0) {
      throw new RangeError("resourceKey must not be empty");
    }
    if (request.kind === "image" || request.kind === "animated-image") {
      return null;
    }

    return invoke<MediaDetail | null>("get_media_detail", {
      resourceKey: request.resourceKey,
      kind: request.kind,
    });
  }
}

export const tauriMediaDetailPort = new TauriMediaDetailPort();
