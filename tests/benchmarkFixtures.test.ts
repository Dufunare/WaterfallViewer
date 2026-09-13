import { describe, expect, it, vi } from "vitest";

import {
  BENCH_BATCH_SIZE,
  createMediaDataset,
  createMediaItem,
  streamDataset,
} from "../benchmarks/mediaFixtures";

describe("benchmark media fixtures", () => {
  it("generates deterministic mixed-media items", () => {
    expect(createMediaItem(0)).toEqual(createMediaItem(0));
    expect(createMediaItem(0).kind).toBe("video");
    expect(createMediaItem(1).kind).toBe("audio");
    expect(createMediaItem(2).kind).toBe("animated-image");
    expect(createMediaItem(3).kind).toBe("image");
    expect(createMediaItem(20).kind).toBe("video");
  });

  it("creates the requested dataset size", () => {
    const items = createMediaDataset(257);
    expect(items).toHaveLength(257);
    expect(items[256]?.id).toBe("bench-media-256");
  });

  it("streams one sync batch followed by bounded append batches", () => {
    const items = createMediaDataset(BENCH_BATCH_SIZE * 2 + 3);
    const syncFirst = vi.fn();
    const append = vi.fn();

    streamDataset(items, syncFirst, append);

    expect(syncFirst).toHaveBeenCalledTimes(1);
    expect(syncFirst.mock.calls[0]?.[0]).toHaveLength(BENCH_BATCH_SIZE);
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0]?.[0]).toHaveLength(BENCH_BATCH_SIZE);
    expect(append.mock.calls[1]?.[0]).toHaveLength(3);
  });

  it("rejects invalid batch sizes", () => {
    expect(() => streamDataset([], () => undefined, () => undefined, 0)).toThrow(RangeError);
  });
});
