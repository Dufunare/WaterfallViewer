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

    // convertFileSrc treats the argument as one filesystem path and encodes the
    // slash in opaque keys such as "1/37". The Rust media protocol expects two
    // path segments, so only use convertFileSrc to obtain the protocol origin.
    const protocolRoot = convertFileSrc("", MEDIA_PROTOCOL);
    return `${protocolRoot.replace(/\/$/, "")}/${resourceKey}`;
  }
}

export const tauriMediaResourcePort = new TauriMediaResourcePort();
