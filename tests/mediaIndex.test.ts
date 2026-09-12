import { describe, expect, it } from "vitest";

import { MediaIndex } from "../src/application/mediaSession";
import type { MediaItem } from "../src/application/ports/mediaScan";

const LARGE_MEDIA_COUNT = 50_000;

function mediaItem(index: number, name = `media-${index}.jpg`): MediaItem {
  return {
    id: `media-${index}`,
    sourceId: "source-large",
    name,
    relativePath: `nested/media-${index}.jpg`,
    kind: "image",
    fileSize: 1024 + index,
    modifiedAtMs: index,
    visual: { width: 1920, height: 1080 },
    resourceKey: `large/${index + 1}`,
  };
}

describe("MediaIndex", () => {
  it("keeps id and positional lookup consistent across 50k items", () => {
    const index = new MediaIndex();

    for (let start = 0; start < LARGE_MEDIA_COUNT; start += 64) {
      const count = Math.min(64, LARGE_MEDIA_COUNT - start);
      index.upsertMany(
        Array.from({ length: count }, (_, offset) => mediaItem(start + offset)),
      );
    }

    expect(index.size).toBe(LARGE_MEDIA_COUNT);
    expect(index.indexOf("media-0")).toBe(0);
    expect(index.indexOf("media-25000")).toBe(25_000);
    expect(index.indexOf("media-49999")).toBe(49_999);
    expect(index.indexOf("missing")).toBe(-1);
    expect(index.at(0)?.id).toBe("media-0");
    expect(index.at(25_000)?.id).toBe("media-25000");
    expect(index.at(49_999)?.id).toBe("media-49999");
    expect(index.at(-1)).toBeUndefined();
    expect(index.at(LARGE_MEDIA_COUNT)).toBeUndefined();
  });

  it("preserves the original order index when an item is replaced", () => {
    const index = new MediaIndex();
    index.upsertMany([mediaItem(0), mediaItem(1), mediaItem(2)]);

    index.upsertMany([mediaItem(1, "replacement.jpg")]);

    expect(index.size).toBe(3);
    expect(index.replacementRevision).toBe(1);
    expect(index.indexOf("media-1")).toBe(1);
    expect(index.at(1)?.name).toBe("replacement.jpg");
    expect(index.ids()).toEqual(["media-0", "media-1", "media-2"]);
  });
});
