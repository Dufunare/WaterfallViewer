import { describe, expect, it } from "vitest";

import {
  JustifiedLayoutBuilder,
  layoutJustified,
} from "../src/layout/justified/justifiedLayout";

const config = {
  viewport: { width: 300, height: 200 },
  targetRowHeight: 100,
  gap: 10,
};

function square(mediaId: string) {
  return { mediaId, width: 100, height: 100 };
}

describe("JustifiedLayoutBuilder", () => {
  it("emits only stable full rows while a stream is still open", () => {
    const builder = new JustifiedLayoutBuilder(config);

    expect(builder.append([square("a"), square("b")])).toEqual([]);
    expect(builder.size).toBe(0);
    expect(builder.pendingCount).toBe(2);
    expect(builder.totalHeight).toBe(0);

    const emitted = builder.append([square("c")]);
    expect(emitted).toHaveLength(3);
    expect(builder.pendingCount).toBe(0);
    expect(builder.rowCount).toBe(1);

    const rightEdge = emitted[2].x + emitted[2].width;
    expect(rightEdge).toBeCloseTo(300);
    expect(emitted[0].height).toBeCloseTo(280 / 3);
    expect(emitted.every((node) => node.rowIndex === 0)).toBe(true);
  });

  it("flushes an unfinished tail as a ragged target-height row", () => {
    const builder = new JustifiedLayoutBuilder(config);
    builder.append([square("a"), square("b")]);

    const flushed = builder.flushPending();
    expect(flushed).toEqual([
      { mediaId: "a", rowIndex: 0, x: 0, y: 0, width: 100, height: 100 },
      { mediaId: "b", rowIndex: 0, x: 110, y: 0, width: 100, height: 100 },
    ]);
    expect(builder.totalHeight).toBe(100);
    expect(builder.pendingCount).toBe(0);
  });

  it("keeps chunked streaming equivalent to one-shot layout after the final flush", () => {
    const items = [
      square("a"),
      { mediaId: "b", width: 200, height: 100 },
      { mediaId: "c", width: 50, height: 100 },
      square("d"),
      { mediaId: "e", width: 160, height: 100 },
    ];

    const incremental = new JustifiedLayoutBuilder(config);
    incremental.append(items.slice(0, 2));
    incremental.append(items.slice(2, 4));
    incremental.append(items.slice(4));
    incremental.flushPending();

    expect(incremental.snapshot()).toEqual(layoutJustified(items, config));
  });

  it("fits a single panorama without exceeding the viewport", () => {
    const result = layoutJustified(
      [{ mediaId: "wide", width: 1000, height: 100 }],
      config,
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].width).toBeCloseTo(300);
    expect(result.nodes[0].height).toBeCloseTo(30);
    expect(result.totalHeight).toBeCloseTo(30);
  });

  it("keeps rows valid even when the configured gap is wider than the viewport", () => {
    const builder = new JustifiedLayoutBuilder({
      viewport: { width: 100, height: 100 },
      targetRowHeight: 20,
      gap: 150,
    });

    builder.append([
      { mediaId: "a", width: 1, height: 100 },
      { mediaId: "b", width: 1, height: 100 },
    ]);
    builder.flushPending();

    const result = builder.snapshot();
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.every((node) => node.width > 0 && node.height > 0)).toBe(true);
    expect(result.rowCount).toBe(2);
  });

  it("rejects an invalid batch atomically", () => {
    const builder = new JustifiedLayoutBuilder(config);
    builder.append([square("existing")]);
    const before = builder.snapshot();

    expect(() =>
      builder.append([
        square("new"),
        { mediaId: "existing", width: 100, height: 100 },
      ]),
    ).toThrow(/duplicate mediaId/);

    expect(builder.snapshot()).toEqual(before);
  });

  it("rejects invalid configuration", () => {
    expect(
      () =>
        new JustifiedLayoutBuilder({
          viewport: { width: 0, height: 100 },
          targetRowHeight: 100,
          gap: 10,
        }),
    ).toThrow(/viewport.width/);

    expect(
      () =>
        new JustifiedLayoutBuilder({
          viewport: { width: 100, height: 100 },
          targetRowHeight: 0,
          gap: 10,
        }),
    ).toThrow(/targetRowHeight/);
  });
});
