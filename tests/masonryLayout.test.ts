import { describe, expect, it } from "vitest";

import {
  MasonryLayoutBuilder,
  layoutMasonry,
  type MasonryLayoutConfig,
  type MediaVisualInfo,
} from "../src/layout/masonry/masonryLayout";

const config: MasonryLayoutConfig = {
  viewport: { width: 320, height: 600 },
  columnCount: 3,
  gap: 10,
};

const items: MediaVisualInfo[] = [
  { mediaId: "a", width: 100, height: 100 },
  { mediaId: "b", width: 100, height: 200 },
  { mediaId: "c", width: 200, height: 100 },
  { mediaId: "d", width: 100, height: 100 },
];

describe("layoutMasonry", () => {
  it("places items into the shortest column while preserving aspect ratio", () => {
    const result = layoutMasonry(items, config);

    expect(result.columnWidth).toBe(100);
    expect(result.nodes).toHaveLength(4);
    expect(result.nodes[0]).toEqual({
      mediaId: "a",
      columnIndex: 0,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(result.nodes[1]).toEqual({
      mediaId: "b",
      columnIndex: 1,
      x: 110,
      y: 0,
      width: 100,
      height: 200,
    });
    expect(result.nodes[2]).toEqual({
      mediaId: "c",
      columnIndex: 2,
      x: 220,
      y: 0,
      width: 100,
      height: 50,
    });
    expect(result.nodes[3]).toEqual({
      mediaId: "d",
      columnIndex: 2,
      x: 220,
      y: 60,
      width: 100,
      height: 100,
    });
    expect(result.totalHeight).toBe(200);
  });

  it("uses the lowest column index as a deterministic tie breaker", () => {
    const squareItems = [
      { mediaId: "a", width: 1, height: 1 },
      { mediaId: "b", width: 1, height: 1 },
      { mediaId: "c", width: 1, height: 1 },
      { mediaId: "d", width: 1, height: 1 },
    ];

    const result = layoutMasonry(squareItems, config);
    expect(result.nodes.map((node) => node.columnIndex)).toEqual([0, 1, 2, 0]);
  });

  it("does not include a trailing gap in total height", () => {
    const result = layoutMasonry(
      [{ mediaId: "single", width: 4, height: 3 }],
      {
        viewport: { width: 200, height: 0 },
        columnCount: 1,
        gap: 24,
      },
    );

    expect(result.nodes[0].height).toBe(150);
    expect(result.totalHeight).toBe(150);
  });

  it("returns a zero-height layout for an empty collection", () => {
    const result = layoutMasonry([], config);
    expect(result.nodes).toEqual([]);
    expect(result.totalHeight).toBe(0);
    expect(result.columnWidth).toBe(100);
  });
});

describe("MasonryLayoutBuilder", () => {
  it("produces identical geometry when the same items arrive in batches", () => {
    const oneShot = layoutMasonry(items, config);
    const builder = new MasonryLayoutBuilder(config);

    const firstBatch = builder.append(items.slice(0, 2));
    const secondBatch = builder.append(items.slice(2));
    const incremental = builder.snapshot();

    expect([...firstBatch, ...secondBatch]).toEqual(oneShot.nodes);
    expect(incremental).toEqual(oneShot);
  });

  it("rejects an invalid batch atomically", () => {
    const builder = new MasonryLayoutBuilder(config);
    builder.append([{ mediaId: "a", width: 100, height: 100 }]);
    const before = builder.snapshot();

    expect(() =>
      builder.append([
        { mediaId: "b", width: 100, height: 100 },
        { mediaId: "broken", width: 0, height: 100 },
      ]),
    ).toThrow("width for broken must be a finite positive number");

    expect(builder.snapshot()).toEqual(before);
  });

  it("rejects duplicate media ids across and within batches", () => {
    const builder = new MasonryLayoutBuilder(config);
    builder.append([{ mediaId: "a", width: 100, height: 100 }]);

    expect(() =>
      builder.append([{ mediaId: "a", width: 200, height: 100 }]),
    ).toThrow("duplicate mediaId: a");

    expect(() =>
      new MasonryLayoutBuilder(config).append([
        { mediaId: "b", width: 100, height: 100 },
        { mediaId: "b", width: 100, height: 100 },
      ]),
    ).toThrow("duplicate mediaId: b");
  });

  it("returns snapshots that cannot mutate internal geometry", () => {
    const builder = new MasonryLayoutBuilder(config);
    const added = builder.append([{ mediaId: "a", width: 100, height: 100 }]);
    const snapshot = builder.snapshot();

    (added[0] as { x: number }).x = 999;
    (snapshot.nodes[0] as { y: number }).y = 999;

    expect(builder.snapshot().nodes[0]).toMatchObject({ x: 0, y: 0 });
  });
});

describe("masonry validation", () => {
  it("rejects invalid layout configuration", () => {
    expect(
      () =>
        new MasonryLayoutBuilder({
          viewport: { width: 320, height: 600 },
          columnCount: 0,
          gap: 10,
        }),
    ).toThrow("columnCount must be a positive integer");

    expect(
      () =>
        new MasonryLayoutBuilder({
          viewport: { width: 20, height: 600 },
          columnCount: 3,
          gap: 10,
        }),
    ).toThrow("viewport width must leave positive space for every column");

    expect(
      () =>
        new MasonryLayoutBuilder({
          viewport: { width: 320, height: 600 },
          columnCount: 3,
          gap: -1,
        }),
    ).toThrow("gap must be a finite non-negative number");
  });

  it("rejects invalid visual metadata", () => {
    expect(() =>
      layoutMasonry(
        [{ mediaId: "broken", width: Number.NaN, height: 100 }],
        config,
      ),
    ).toThrow("width for broken must be a finite positive number");

    expect(() =>
      layoutMasonry([{ mediaId: " ", width: 100, height: 100 }], config),
    ).toThrow("mediaId must not be empty");
  });
});
