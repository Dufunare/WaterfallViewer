import { describe, expect, it } from "vitest";

import { FreeformCanvasLayoutBuilder } from "../src/layout/canvas/freeformCanvasLayout";
import type { MediaVisualInfo } from "../src/layout/types";

function images(count: number): MediaVisualInfo[] {
  const ratios = [1, 4 / 3, 16 / 9, 9 / 16, 3 / 4, 2, 1 / 2, 3, 1 / 3];
  return Array.from({ length: count }, (_, index) => ({
    mediaId: "media-" + index,
    width: 1000 * ratios[index % ratios.length],
    height: 1000,
  }));
}

function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
}

describe("freeform canvas packing", () => {
  it("creates an incremental, deterministic atlas without moving earlier media", () => {
    const input = images(512);
    const streamed = new FreeformCanvasLayoutBuilder();
    streamed.append(input.slice(0, 16));
    const initial = streamed.snapshot();
    for (let i = 16; i < input.length; i += 37) streamed.append(input.slice(i, i + 37));
    expect(streamed.snapshot().slice(0, initial.length)).toEqual(initial);
    const oneShot = new FreeformCanvasLayoutBuilder();
    oneShot.append(input);
    expect(streamed.snapshot()).toEqual(oneShot.snapshot());
    expect(streamed.firstNode).toEqual(oneShot.firstNode);
  });

  it("packs without overlaps and expands in both dimensions", () => {
    const input = images(4096);
    const atlas = new FreeformCanvasLayoutBuilder();
    for (let i = 0; i < input.length; i += 64) atlas.append(input.slice(i, i + 64));
    const bounds = atlas.bounds;
    expect(atlas.size).toBe(4096);
    expect(atlas.blockCount).toBeGreaterThan(10);
    expect(bounds.width / bounds.height).toBeGreaterThan(0.95);
    expect(bounds.width / bounds.height).toBeLessThan(1.85);
    const nodes = atlas.snapshot();
    for (const node of nodes) {
      const hits = atlas.query({
        x: node.x - 5, y: node.y - 5,
        width: node.width + 10, height: node.height + 10,
      });
      expect(hits.map((hit) => hit.mediaId)).toEqual([node.mediaId]);
    }
    const filled = nodes.reduce((area, node) => area + node.width * node.height, 0);
    expect(filled / (bounds.width * bounds.height)).toBeGreaterThan(0.4);
  });

  it("spatial queries match full scans", () => {
    const atlas = new FreeformCanvasLayoutBuilder();
    atlas.append(images(768));
    const nodes = atlas.snapshot();
    for (let i = 0; i < 32; i++) {
      const view = { x: -3500 + i * 250, y: -3000 + i * 160, width: 1450, height: 900 };
      expect(atlas.query(view).map((node) => node.mediaId)).toEqual(
        nodes.filter((node) => intersects(node, view)).map((node) => node.mediaId),
      );
    }
  });

  it("keeps a narrow default gap and reuses recent partially filled blocks", () => {
    const atlas = new FreeformCanvasLayoutBuilder();
    const pair = atlas.append([
      { mediaId: "a", width: 200, height: 200 },
      { mediaId: "b", width: 200, height: 200 },
    ]);
    const a = pair[0];
    const b = pair[1];
    const horizontalGap = Math.abs(b.x - (a.x + a.width));
    const verticalGap = Math.abs(b.y - (a.y + a.height));
    expect(Math.min(horizontalGap, verticalGap)).toBeLessThanOrEqual(4);

    const bulk = images(250);
    atlas.append(bulk);
    const before = atlas.snapshot();
    const append = atlas.append(images(250).map((item, index) => ({
      ...item, mediaId: "more-" + index,
    })));
    expect(atlas.snapshot().slice(0, before.length)).toEqual(before);
    expect(append).toHaveLength(250);
  });

  it("bounded count agrees with visibility queries", () => {
    const atlas = new FreeformCanvasLayoutBuilder();
    atlas.append(images(768));
    const rect = { x: -700, y: -650, width: 2300, height: 2100 };
    const count = atlas.query(rect).length;
    expect(atlas.count(rect)).toBe(count);
    expect(atlas.count(rect, 10)).toBe(Math.min(count, 10));
    expect(() => atlas.count(rect, 0)).toThrow();
  });

  it("rejects invalid batches atomically and bounds panoramas", () => {
    const atlas = new FreeformCanvasLayoutBuilder();
    const first = atlas.append([{ mediaId: "first", width: 16, height: 9 }])[0];
    expect(first.width / first.height).toBeCloseTo(16 / 9, 1);
    expect(() => atlas.append([
      { mediaId: "second", width: 8, height: 10 },
      { mediaId: "second", width: 1, height: 1 },
    ])).toThrow(/duplicate/);
    expect(() => atlas.append([{ mediaId: "invalid", width: 0, height: 1 }])).toThrow();
    expect(atlas.size).toBe(1);
    const outlier = atlas.append([{ mediaId: "panorama", width: 50_000, height: 100 }])[0];
    expect(Math.max(outlier.width, outlier.height)).toBeLessThanOrEqual(720);
    expect(atlas.query({ x: first.x, y: first.y, width: first.width, height: first.height })[0].mediaId)
      .toBe("first");
  });
});
