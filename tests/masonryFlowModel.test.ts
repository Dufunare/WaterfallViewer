import { describe, expect, it } from "vitest";

import { MasonryFlowModel } from "../src/application/flow/masonryFlowModel";
import type { MediaItem } from "../src/application/ports/mediaScan";

function media(
  id: string,
  width: number | null = 100,
  height: number | null = 100,
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
    resourceKey: `1/${id}`,
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
      media("c", 200, 100),
    ]);

    const snapshot = model.snapshot();
    expect(snapshot.sessionId).toBe("session-1");
    expect(snapshot.itemCount).toBe(3);
    expect(snapshot.layoutItemCount).toBe(3);
    expect(snapshot.deferredMedia).toEqual([]);
    expect(snapshot.layout.nodes.map((node) => node.mediaId)).toEqual([
      "a",
      "b",
      "c",
    ]);

    expect(
      model.queryVisible({ x: 0, y: 0, width: 220, height: 120 }).map((node) => node.mediaId),
    ).toEqual(["a", "b"]);
  });

  it("keeps append-only scan updates equivalent to a one-shot sync", () => {
    const all = [
      media("a", 100, 100),
      media("b", 100, 200),
      media("c", 200, 100),
      media("d", 100, 100),
    ];
    const appended = new MasonryFlowModel(config);
    appended.sync("session-1", all.slice(0, 2));
    appended.append("session-1", all.slice(2));

    const oneShot = new MasonryFlowModel(config);
    oneShot.sync("session-1", all);

    expect(appended.snapshot().layout).toEqual(oneShot.snapshot().layout);
    expect(appended.snapshot().deferredMedia).toEqual(oneShot.snapshot().deferredMedia);
  });

  it("rebuilds when existing visual metadata changes", () => {
    const model = new MasonryFlowModel(config);
    model.sync("session-1", [media("a", 100, 100), media("b", 100, 100)]);
    const before = model.snapshot().layout.nodes[0];

    model.sync("session-1", [media("a", 100, 200), media("b", 100, 100)]);
    const after = model.snapshot().layout.nodes[0];

    expect(after.height).not.toBe(before.height);
  });

  it("resets old geometry when the scan session changes", () => {
    const model = new MasonryFlowModel(config);
    model.sync("session-1", [media("old", 100, 100)]);
    model.sync("session-2", [media("new", 200, 100)]);

    const snapshot = model.snapshot();
    expect(snapshot.sessionId).toBe("session-2");
    expect(snapshot.layout.nodes.map((node) => node.mediaId)).toEqual(["new"]);
  });

  it("reflows retained media when layout configuration changes", () => {
    const model = new MasonryFlowModel(config);
    model.sync("session-1", [media("a"), media("b"), media("c")]);

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

  it("uses square fallback geometry when image metadata is unavailable", () => {
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
    for (const id of ["missing", "invalid"]) {
      const node = snapshot.layout.nodes.find((candidate) => candidate.mediaId === id)!;
      expect(node.width / node.height).toBeCloseTo(1);
    }
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
    model.sync("session-1", [media("a"), media("b")]);
    const before = model.snapshot();

    expect(() =>
      model.configure({
        viewport: { width: 0, height: 160 },
        columnCount: 2,
        gap: 20,
      }),
    ).toThrow();

    expect(model.snapshot()).toEqual(before);
  });
});
