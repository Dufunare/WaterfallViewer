import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import type { MediaResourcePort } from "../../application/ports/mediaResource";

const MEDIA_PROTOCOL = "waterfall-media";

export class TauriMediaResourcePort implements MediaResourcePort {
  readonly #loopbackOrigins: readonly string[];

  constructor(loopbackOrigins: readonly string[] = []) {
    this.#loopbackOrigins = loopbackOrigins.map(normalizeOrigin);
  }

  uriFor(resourceKey: string): string {
    validateResourceKey(resourceKey);

    if (this.#loopbackOrigins.length > 0) {
      const origin = this.#loopbackOrigins[resourceShard(resourceKey, this.#loopbackOrigins.length)];
      return `${origin}/${resourceKey}`;
    }

    const protocolRoot = convertFileSrc("", MEDIA_PROTOCOL);
    return `${protocolRoot.replace(/\/$/, "")}/${resourceKey}`;
  }
}

/** Production-compatible resource transport used by Canvas and preview. */
export const tauriMediaResourcePort = new TauriMediaResourcePort();

/** Experimental source transport used only by legacy Flow. */
export async function createTauriFlowMediaResourcePort(): Promise<TauriMediaResourcePort> {
  const origins = await invoke<string[]>("get_media_http_origins");
  return new TauriMediaResourcePort(origins);
}

function validateResourceKey(resourceKey: string): void {
  if (resourceKey.trim().length === 0) {
    throw new RangeError("resourceKey must not be empty");
  }
  if (!/^\d+\/\d+$/.test(resourceKey)) {
    throw new RangeError("resourceKey has an invalid format");
  }
}

function normalizeOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+$/.test(trimmed)) {
    throw new Error("media loopback origin has an invalid format");
  }
  return trimmed;
}

function resourceShard(resourceKey: string, count: number): number {
  const key = Number(resourceKey.slice(resourceKey.indexOf("/") + 1));
  return Number.isSafeInteger(key) ? key % count : stableStringHash(resourceKey) % count;
}

function stableStringHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
