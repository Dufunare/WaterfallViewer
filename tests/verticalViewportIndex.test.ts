import { describe, expect, it } from "vitest";

import type { LayoutNode } from "../src/layout/types";
import {
  VerticalViewportIndex,
  queryVisibleNodes,
} from "../src/layout/viewport/verticalViewportIndex";

function node(
  mediaId: string,
  x: number,
  y: number,
  width = 100,
  height = 100,
): LayoutNode {
  return { mediaId, x, y, width, height };
}

describe("VerticalViewportIndex", () => {
  it("returns only nodes intersecting the viewport while preserving insertion order", () => {
    const index = new VerticalViewportIndex([
      node("late", 0, 240),
      node("visible-b", 100, 80),
      node("above", 0, -150),
      node("visible-a", 0, 20),
    ]);

    expect(
      index.query({ x: 0, y: 0, width: 200, height: 150 }).map((item) => item.mediaId),
    ).toEqual(["visible-b", "visible-a"]);
  });

  it("supports symmetric and per-edge overscan", () => {
    const index = new VerticalViewportIndex([
      node("above", 0, -70, 100, 40),
      node("inside", 0, 10),
      node("below", 0, 130, 100, 40),
      node("right", 230, 10),
    ]);

    const viewport = { x: 0, y: 0, width: 200, height: 100 };

    expect(index.query(viewport).map((item) => item.mediaId)).toEqual(["inside"]);
    expect(
      index.query(viewport, { overscan: 40 }).map((item) => item.mediaId),
    ).toEqual(["above", "inside", "below", "right"]);
    expect(
      index
        .query(viewport, { overscan: { bottom: 40 } })
        .map((item) => item.mediaId),
    ).toEqual(["inside", "below"]);
  });

  it("keeps very tall nodes discoverable through the prefix-bottom index", () => {
    const index = new VerticalViewportIndex([
      node("tall", 0, 0, 100, 2000),
      node("short-1", 100, 100, 100, 50),
      node("short-2", 100, 300, 100, 50),
      node("short-3", 100, 600, 100, 50),
    ]);

    expect(
      index
        .query({ x: 0, y: 1500, width: 100, height: 100 })
        .map((item) => item.mediaId),
    ).toEqual(["tall"]);
  });

  it("filters horizontally as well as vertically", () => {
    const index = new VerticalViewportIndex([
      node("left", -200, 20, 50, 50),
      node("inside", 20, 20, 50, 50),
      node("right", 200, 20, 50, 50),
    ]);

    expect(
      index
        .query({ x: 0, y: 0, width: 100, height: 100 })
        .map((item) => item.mediaId),
    ).toEqual(["inside"]);
  });

  it("produces the same query result when nodes arrive incrementally", () => {
    const all = [
      node("a", 0, 0),
      node("b", 100, 50),
      node("c", 0, 180),
      node("d", 100, 260),
      node("e", 0, 400),
    ];
    const viewport = { x: 0, y: 120, width: 200, height: 220 };

    const oneShot = new VerticalViewportIndex(all);
    const incremental = new VerticalViewportIndex<LayoutNode>();
    incremental.append(all.slice(0, 2));
    incremental.append(all.slice(2, 4));
    incremental.append(all.slice(4));

    expect(incremental.query(viewport)).toEqual(oneShot.query(viewport));
    expect(incremental.snapshot()).toEqual(all);
  });

  it("rejects invalid or duplicate batches atomically", () => {
    const index = new VerticalViewportIndex([node("a", 0, 0)]);

    expect(() =>
      index.append([node("b", 0, 120), node("a", 0, 240)]),
    ).toThrow(/duplicate mediaId/);
    expect(index.snapshot().map((item) => item.mediaId)).toEqual(["a"]);

    expect(() =>
      index.append([node("b", 0, 120), node("c", 0, Number.NaN)]),
    ).toThrow(/must be finite/);
    expect(index.snapshot().map((item) => item.mediaId)).toEqual(["a"]);
  });

  it("returns clones so callers cannot mutate indexed geometry", () => {
    const index = new VerticalViewportIndex([node("a", 10, 20)]);
    const visible = index.query({ x: 0, y: 0, width: 200, height: 200 });

    visible[0].x = 999;

    expect(index.snapshot()[0].x).toBe(10);
  });

  it("validates viewport and overscan values", () => {
    const index = new VerticalViewportIndex([node("a", 0, 0)]);

    expect(() => index.query({ x: 0, y: 0, width: 0, height: 100 })).toThrow(
      /viewport.width/,
    );
    expect(() =>
      index.query(
        { x: 0, y: 0, width: 100, height: 100 },
        { overscan: -1 },
      ),
    ).toThrow(/overscan/);
  });
});

describe("queryVisibleNodes", () => {
  it("provides a one-shot query helper", () => {
    expect(
      queryVisibleNodes(
        [node("a", 0, 0), node("b", 0, 300)],
        { x: 0, y: 0, width: 100, height: 150 },
      ).map((item) => item.mediaId),
    ).toEqual(["a"]);
  });
});
