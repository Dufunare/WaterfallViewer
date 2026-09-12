import { convertFileSrc } from "@tauri-apps/api/core";

import type { MediaResourcePort } from "../../application/ports/mediaResource";

const MEDIA_PROTOCOL = "waterfall-media";

export class TauriMediaResourcePort implements MediaResourcePort {
  uriFor(resourceKey: string): string {
    if (resourceKey.trim().length === 0) {
      throw new RangeError("resourceKey must not be empty");
    }
    if (!/^\d+\/\d+$/.test(resourceKey)) {
      throw new RangeError("resourceKey has an invalid format");
    }

    return convertFileSrc(resourceKey, MEDIA_PROTOCOL);
  }
}

export const tauriMediaResourcePort = new TauriMediaResourcePort();
