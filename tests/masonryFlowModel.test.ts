import { describe, expect, it } from "vitest";

import { MasonryFlowModel } from "../src/application/flow/masonryFlowModel";
import type { MediaItem } from "../src/application/ports/mediaScan";

function media(
  id: string,
  width: number | null,
  height: number | null,
): MediaItem {
  return {
    id,
    sourceId: "source-1",
    name: `${id}.jpg`,
    relativePath: `${id}.jpg`,
    kind: "image",
    fileSize: 100,
    modifiedAtMs: null,
    visual:
      width === null || height === null
        ? null
        : {
            width,
            height,
          },
  };
}

const config = {
  viewport: { width: 220, height: 160 },
  columnCount: 2,
  gap: 20,
};

describe("MasonryFlowModel", () => {
  it("projects session media into masonry geometry and viewport results", () => {
    const model = new MasonryFlowModel(config);
    model.sync("session-1", [
      media("a", 100, 100),
      media("b", 100, 200),
      media("c", 100, 100),
    ]);

    const snapshot = model.snapshot();
    expect(snapshot.sessionId).toBe("session-1");
    expect(snapshot.itemCount).toBe(3);
    expect(snapshot.layoutItemCount).toBe(3);
    expect(snapshot.layout.nodes.map((node) => node.mediaId)).toEqual([
      "a",
      "b",
      "c",
    ]);

    expect(
      model
        .queryVisible({ x: 0, y: 0, width: 220, height: 105 })
        .map((node) => node.mediaId),
    ).toEqual(["a", "b"]);
  });

  it("keeps append-only scan updates equivalent to a one-shot sync", () => {
    const items = [
      media("a", 100, 100),
      media("b", 100, 200),
      media("c", 200, 100),
      media("d", 100, 150),
    ];

    const incremental = new MasonryFlowModel(config);
    incremental.sync("session-1", items.slice(0, 2));
    incremental.sync("session-1", items.slice(0, 3));
    incremental.sync("session-1", items);

    const oneShot = new MasonryFlowModel(config);
    oneShot.sync("session-1", items);

    expect(incremental.snapshot()).toEqual(oneShot.snapshot());
  });

  it("rebuilds when existing visual metadata changes", () => {
    const model = new MasonryFlowModel(config);
    model.sync("session-1", [
      media("a", 100, 100),
      media("b", 100, 100),
      media("c", 100, 100),
    ]);
    const before = model.snapshot().layout.nodes.find((node) => node.mediaId === "c")!;

    model.sync("session-1", [
      media("a", 100, 300),
      media("b", 100, 100),
      media("c", 100, 100),
    ]);
    const after = model.snapshot().layout.nodes.find((node) => node.mediaId === "c")!;

    expect(before.columnIndex).toBe(0);
    expect(after.columnIndex).toBe(1);
    expect(after.y).toBeGreaterThan(0);
  });

  it("resets old geometry when the scan session changes", () => {
    const model = new MasonryFlowModel(config);
    model.sync("session-1", [media("old", 100, 100)]);
    model.sync("session-2", [media("new", 100, 100)]);

    expect(model.snapshot().layout.nodes.map((node) => node.mediaId)).toEqual([
      "new",
    ]);
  });

  it("reflows retained media when layout configuration changes", () => {
    const model = new MasonryFlowModel(config);
    model.sync("session-1", [media("a", 100, 100), media("b", 100, 100)]);

    expect(model.snapshot().layout.columnWidth).toBe(100);

    model.configure({
      viewport: { width: 330, height: 160 },
      columnCount: 3,
      gap: 15,
    });

    const snapshot = model.snapshot();
    expect(snapshot.layout.columnWidth).toBe(100);
    expect(snapshot.layout.nodes[1].columnIndex).toBe(1);
    expect(snapshot.layout.nodes[1].x).toBe(115);
  });

  it("keeps images without usable visual metadata in layout with square fallback geometry", () => {
    const model = new MasonryFlowModel(config);
    model.sync("session-1", [
      media("valid", 100, 100),
      media("missing", null, null),
      media("invalid", 0, 100),
    ]);

    const snapshot = model.snapshot();
    expect(snapshot.itemCount).toBe(3);
    expect(snapshot.layoutItemCount).toBe(3);
    expect(snapshot.deferredMedia).toEqual([]);
    expect(snapshot.layout.nodes.map((node) => node.mediaId)).toEqual([
      "valid",
      "missing",
      "invalid",
    ]);
    expect(snapshot.layout.nodes[1].width).toBe(snapshot.layout.nodes[1].height);
    expect(snapshot.layout.nodes[2].width).toBe(snapshot.layout.nodes[2].height);
  });

  it("rejects ambiguous duplicate ids without mutating the prior projection", () => {
    const model = new MasonryFlowModel(config);
    model.sync("session-1", [media("a", 100, 100)]);

    expect(() =>
      model.sync("session-1", [media("a", 100, 100), media("a", 200, 200)]),
    ).toThrow(/duplicate media id/);

    expect(model.snapshot().layout.nodes.map((node) => node.mediaId)).toEqual([
      "a",
    ]);
  });

  it("keeps existing state when a replacement config is invalid", () => {
    const model = new MasonryFlowModel(config);
    model.sync("session-1", [media("a", 100, 100)]);

    expect(() =>
      model.configure({
        viewport: { width: 10, height: 160 },
        columnCount: 2,
        gap: 20,
      }),
    ).toThrow();

    expect(model.snapshot().layout.columnWidth).toBe(100);
    expect(model.snapshot().layout.nodes).toHaveLength(1);
  });
});
