import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import type { MediaResourcePort } from "../../application/ports/mediaResource";

const MEDIA_PROTOCOL = "waterfall-media";

export class TauriMediaResourcePort implements MediaResourcePort {
  readonly #loopbackOrigin: string | null;

  constructor(loopbackOrigin: string | null = null) {
    this.#loopbackOrigin = normalizeOrigin(loopbackOrigin);
  }

  uriFor(resourceKey: string): string {
    if (resourceKey.trim().length === 0) {
      throw new RangeError("resourceKey must not be empty");
    }
    if (!/^\d+\/\d+$/.test(resourceKey)) {
      throw new RangeError("resourceKey has an invalid format");
    }

    if (this.#loopbackOrigin !== null) {
      return `${this.#loopbackOrigin}/${resourceKey}`;
    }

    const protocolRoot = convertFileSrc("", MEDIA_PROTOCOL);
    return `${protocolRoot.replace(/\/$/, "")}/${resourceKey}`;
  }
}

export async function createTauriMediaResourcePort(): Promise<TauriMediaResourcePort> {
  const origin = await invoke<string>("get_media_http_origin");
  return new TauriMediaResourcePort(origin);
}

function normalizeOrigin(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim().replace(/\/$/, "");
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+$/.test(trimmed)) {
    throw new Error("media loopback origin has an invalid format");
  }
  return trimmed;
}
