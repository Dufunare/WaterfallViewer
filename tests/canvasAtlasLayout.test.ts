import { describe, expect, it } from "vitest";

import {
  CanvasAtlasLayoutBuilder,
  layoutCanvasAtlas,
} from "../src/layout/canvas/canvasAtlasLayout";

const config = {
  worldWidth: 350,
  itemHeight: 100,
  gap: 10,
  minItemWidth: 25,
};

function visual(mediaId: string, width = 100, height = 100) {
  return { mediaId, width, height };
}

describe("CanvasAtlasLayoutBuilder", () => {
  it("keeps existing world coordinates stable across append batches", () => {
    const builder = new CanvasAtlasLayoutBuilder(config);
    const first = builder.append([visual("a"), visual("b")]);
    const before = first.map((node) => ({ ...node }));

    const second = builder.append([visual("c"), visual("d")]);
    const snapshot = builder.snapshot();

    expect(snapshot.nodes.slice(0, 2)).toEqual(before);
    expect(second.map((node) => [node.mediaId, node.rowIndex, node.x, node.y])).toEqual([
      ["c", 0, 220, 0],
      ["d", 1, 0, 110],
    ]);
    expect(snapshot.rowCount).toBe(2);
  });

  it("derives widths from aspect ratios and clamps extreme media", () => {
    const result = layoutCanvasAtlas(
      [
        visual("wide", 1000, 100),
        visual("tall", 10, 100),
      ],
      config,
    );

    expect(result.nodes[0]).toMatchObject({
      mediaId: "wide",
      x: 0,
      y: 0,
      width: 350,
      height: 100,
    });
    expect(result.nodes[1]).toMatchObject({
      mediaId: "tall",
      x: 0,
      y: 110,
      width: 25,
      height: 100,
    });
  });

  it("reports tight content bounds rather than the configured world width", () => {
    const builder = new CanvasAtlasLayoutBuilder(config);
    builder.append([visual("a"), visual("b")]);

    expect(builder.bounds).toEqual({ x: 0, y: 0, width: 210, height: 100 });
  });

  it("produces the same atlas when media arrives in chunks", () => {
    const items = [
      visual("a"),
      visual("b", 200, 100),
      visual("c", 50, 100),
      visual("d", 300, 100),
      visual("e", 20, 100),
    ];

    const incremental = new CanvasAtlasLayoutBuilder(config);
    incremental.append(items.slice(0, 2));
    incremental.append(items.slice(2, 4));
    incremental.append(items.slice(4));

    expect(incremental.snapshot()).toEqual(layoutCanvasAtlas(items, config));
  });

  it("rejects an invalid append batch without mutating prior placement", () => {
    const builder = new CanvasAtlasLayoutBuilder(config);
    builder.append([visual("existing")]);
    const before = builder.snapshot();

    expect(() =>
      builder.append([
        visual("new"),
        visual("new"),
      ]),
    ).toThrow(/duplicate mediaId/);

    expect(builder.snapshot()).toEqual(before);
  });

  it("validates atlas configuration", () => {
    expect(
      () =>
        new CanvasAtlasLayoutBuilder({
          worldWidth: 100,
          itemHeight: 100,
          gap: 0,
          minItemWidth: 101,
        }),
    ).toThrow(/minItemWidth/);

    expect(
      () =>
        new CanvasAtlasLayoutBuilder({
          worldWidth: 0,
          itemHeight: 100,
          gap: 0,
        }),
    ).toThrow(/worldWidth/);
  });
});
