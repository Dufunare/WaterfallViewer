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

    // convertFileSrc treats its first argument as one filesystem path and URL
    // encodes it wholesale. Passing an opaque key such as "1/37" therefore
    // produces "1%2F37", while the Rust custom-protocol handler expects the
    // path segments "/1/37". Use convertFileSrc only to obtain the
    // platform-specific custom-protocol origin, then append the already-
    // validated opaque key as URL path segments.
    const protocolRoot = convertFileSrc("", MEDIA_PROTOCOL);
    return `${protocolRoot.replace(/\/$/, "")}/${resourceKey}`;
  }
}

export const tauriMediaResourcePort = new TauriMediaResourcePort();
