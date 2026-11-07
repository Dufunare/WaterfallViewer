import { describe, expect, it } from "vitest";

import { JustifiedFlowModel } from "../src/application/flow/justifiedFlowModel";
import type { MediaItem } from "../src/application/ports/mediaScan";

const config = {
  viewport: { width: 300, height: 200 },
  targetRowHeight: 100,
  gap: 10,
};

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
        : { width, height },
    resourceKey: `1/${id.length}`,
  };
}

describe("JustifiedFlowModel", () => {
  it("indexes only stable rows until the stream becomes terminal", () => {
    const model = new JustifiedFlowModel(config);
    model.sync("session-1", [media("a"), media("b")]);

    expect(model.itemCount).toBe(2);
    expect(model.layoutItemCount).toBe(0);
    expect(model.pendingCount).toBe(2);
    expect(model.queryVisible({ x: 0, y: 0, width: 300, height: 200 })).toEqual([]);

    model.append("session-1", [media("c")]);
    expect(model.layoutItemCount).toBe(3);
    expect(model.pendingCount).toBe(0);
    expect(
      model
        .queryVisible({ x: 0, y: 0, width: 300, height: 200 })
        .map((node) => node.mediaId),
    ).toEqual(["a", "b", "c"]);
  });

  it("flushes the ragged tail exactly once at terminal state", () => {
    const model = new JustifiedFlowModel(config);
    model.sync("session-1", [media("a"), media("b")]);

    model.markTerminal();
    model.markTerminal();

    const snapshot = model.snapshot();
    expect(snapshot.terminal).toBe(true);
    expect(snapshot.layoutItemCount).toBe(2);
    expect(snapshot.layout.pendingCount).toBe(0);
    expect(snapshot.layout.rowCount).toBe(1);
    expect(snapshot.layout.nodes[1].x + snapshot.layout.nodes[1].width).toBe(210);
  });

  it("supports terminal full-state sync for an already completed scan", () => {
    const model = new JustifiedFlowModel(config);
    model.sync("session-1", [media("a"), media("b")], true);

    expect(model.terminal).toBe(true);
    expect(model.pendingCount).toBe(0);
    expect(model.layoutItemCount).toBe(2);
  });

  it("reflows a completed scan when viewport configuration changes", () => {
    const model = new JustifiedFlowModel(config);
    model.sync("session-1", [media("a"), media("b")], true);

    model.configure({
      viewport: { width: 180, height: 200 },
      targetRowHeight: 100,
      gap: 10,
    });

    const snapshot = model.snapshot();
    expect(snapshot.terminal).toBe(true);
    expect(snapshot.layout.pendingCount).toBe(0);
    expect(snapshot.layout.nodes).toHaveLength(2);
    expect(snapshot.layout.nodes[1].x + snapshot.layout.nodes[1].width).toBeCloseTo(180);
  });

  it("uses square fallback geometry for metadata-light images", () => {
    const model = new JustifiedFlowModel(config);
    model.sync(
      "session-1",
      [
        media("valid"),
        media("missing", null, null),
        media("invalid", 0, 100),
      ],
      true,
    );

    const snapshot = model.snapshot();
    expect(snapshot.itemCount).toBe(3);
    expect(snapshot.layoutItemCount).toBe(3);
    expect(snapshot.deferredMedia).toEqual([]);
  });

  it("rebuilds cleanly when the session changes", () => {
    const model = new JustifiedFlowModel(config);
    model.sync("session-1", [media("old")], true);
    model.sync("session-2", [media("new-a"), media("new-b")], true);

    const snapshot = model.snapshot();
    expect(snapshot.sessionId).toBe("session-2");
    expect(snapshot.layout.nodes.map((node) => node.mediaId)).toEqual([
      "new-a",
      "new-b",
    ]);
  });

  it("rejects appends after terminal flush", () => {
    const model = new JustifiedFlowModel(config);
    model.sync("session-1", [media("a")], true);

    expect(() => model.append("session-1", [media("b")])).toThrow(
      /after justified flow is terminal/,
    );
  });
});
