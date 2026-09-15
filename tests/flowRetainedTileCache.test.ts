import { describe, expect, it } from "vitest";

import type { BrowserTile } from "../src/application/browser/mediaBrowserController";
import { FlowRetainedTileCache } from "../src/presentation/flowRetainedTileCache";

function tile(index: number, y = index * 100): BrowserTile {
  return {
    mediaId: `media-${index}`,
    name: `media-${index}.jpg`,
    relativePath: `media-${index}.jpg`,
    kind: "image",
    x: 0,
    y,
    width: 100,
    height: 100,
    priority: "overscan",
    thumbnailStatus: "ready",
    thumbnailUri: `test-media://${index}`,
    thumbnailError: null,
  };
}

describe("FlowRetainedTileCache", () => {
  it("keeps revealed tiles after they leave the current snapshot", () => {
    const cache = new FlowRetainedTileCache(4);
    cache.resetForSession("session-1");
    cache.retain(tile(1));
    cache.retain(tile(2));

    expect(cache.historicalExcluding(new Set(["media-2"])).map((item) => item.mediaId)).toEqual([
      "media-1",
    ]);
  });

  it("evicts least recently used entries instead of growing without bound", () => {
    const cache = new FlowRetainedTileCache(2);
    cache.resetForSession("session-1");
    cache.retain(tile(1));
    cache.retain(tile(2));
    cache.updateCurrent([tile(1, 10)]);
    cache.retain(tile(3));

    expect(cache.has("media-1")).toBe(true);
    expect(cache.has("media-2")).toBe(false);
    expect(cache.has("media-3")).toBe(true);
  });

  it("drops retained pixels when the source session changes", () => {
    const cache = new FlowRetainedTileCache(4);
    cache.resetForSession("session-1");
    cache.retain(tile(1));

    expect(cache.resetForSession("session-2")).toBe(true);
    expect(cache.size).toBe(0);
  });
});
