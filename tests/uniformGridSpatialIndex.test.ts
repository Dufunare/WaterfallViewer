import { describe, expect, it } from "vitest";

import { UniformGridSpatialIndex } from "../src/layout/spatial/uniformGridSpatialIndex";

function node(
  mediaId: string,
  x: number,
  y: number,
  width = 50,
  height = 50,
) {
  return { mediaId, x, y, width, height };
}

describe("UniformGridSpatialIndex", () => {
  it("queries intersecting nodes across positive and negative cells", () => {
    const index = new UniformGridSpatialIndex(100);
    index.upsertMany([
      node("left", -140, -20, 80, 40),
      node("center", 10, 10),
      node("right", 240, 10),
    ]);

    expect(
      index.query({ x: -100, y: -50, width: 220, height: 120 }).map((item) => item.mediaId),
    ).toEqual(["left", "center"]);
  });

  it("deduplicates nodes spanning several grid cells", () => {
    const index = new UniformGridSpatialIndex(100);
    index.upsertMany([node("large", 25, 25, 250, 250)]);

    expect(index.query({ x: 0, y: 0, width: 300, height: 300 })).toHaveLength(1);
  });

  it("moves existing nodes without changing stable insertion order", () => {
    const index = new UniformGridSpatialIndex(100);
    index.upsertMany([node("a", 0, 0), node("b", 20, 20)]);
    index.upsertMany([node("a", 500, 500)]);

    expect(index.query({ x: 0, y: 0, width: 100, height: 100 }).map((item) => item.mediaId)).toEqual([
      "b",
    ]);
    expect(index.snapshot().map((item) => item.mediaId)).toEqual(["a", "b"]);
    expect(index.get("a")?.x).toBe(500);
  });

  it("removes nodes and prunes their memberships", () => {
    const index = new UniformGridSpatialIndex(100);
    index.upsertMany([node("a", 0, 0), node("b", 200, 0)]);

    expect(index.remove("a")).toBe(true);
    expect(index.remove("a")).toBe(false);
    expect(index.size).toBe(1);
    expect(index.query({ x: 0, y: 0, width: 100, height: 100 })).toEqual([]);
  });

  it("rejects an invalid batch atomically", () => {
    const index = new UniformGridSpatialIndex(100);
    index.upsertMany([node("existing", 0, 0)]);

    expect(() =>
      index.upsertMany([
        node("new", 100, 0),
        node("new", 200, 0),
      ]),
    ).toThrow(/duplicate mediaId/);

    expect(index.snapshot()).toEqual([node("existing", 0, 0)]);
  });

  it("treats edge-touching rectangles as non-intersecting", () => {
    const index = new UniformGridSpatialIndex(100);
    index.upsertMany([node("a", 0, 0, 100, 100)]);

    expect(index.query({ x: 100, y: 0, width: 50, height: 50 })).toEqual([]);
    expect(index.query({ x: 99, y: 0, width: 50, height: 50 })).toHaveLength(1);
  });
});
