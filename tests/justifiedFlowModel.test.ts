import { describe, expect, it } from "vitest";

import { JustifiedFlowModel } from "../src/application/flow/justifiedFlowModel";
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
  viewport: { width: 600, height: 300 },
  targetRowHeight: 180,
  gap: 10,
};

describe("JustifiedFlowModel", () => {
  it("indexes only stable rows until the stream becomes terminal", () => {
    const model = new JustifiedFlowModel(config);
    model.sync("session-1", [
      media("a", 400, 300),
      media("b", 400, 300),
      media("c", 400, 300),
      media("tail", 100, 100),
    ]);

    const snapshot = model.snapshot();
    expect(snapshot.itemCount).toBe(4);
    expect(snapshot.layout.pendingCount).toBeGreaterThan(0);
    expect(snapshot.layoutItemCount).toBeLessThan(snapshot.itemCount);
  });

  it("flushes the ragged tail exactly once at terminal state", () => {
    const model = new JustifiedFlowModel(config);
    model.sync("session-1", [media("a"), media("b"), media("c")]);
    model.markTerminal();
    const first = model.snapshot();
    model.markTerminal();
    const second = model.snapshot();

    expect(first.layout.pendingCount).toBe(0);
    expect(second.layout).toEqual(first.layout);
  });

  it("supports terminal full-state sync for an already completed scan", () => {
    const model = new JustifiedFlowModel(config);
    model.sync("session-1", [media("a"), media("b")], true);

    const snapshot = model.snapshot();
    expect(snapshot.layout.pendingCount).toBe(0);
    expect(snapshot.layoutItemCount).toBe(2);
  });

  it("reflows a completed scan when viewport configuration changes", () => {
    const model = new JustifiedFlowModel({
      viewport: { width: 180, height: 300 },
      targetRowHeight: 100,
      gap: 0,
    });
    model.sync("session-1", [media("a"), media("b")], true);

    model.configure({
      viewport: { width: 180, height: 300 },
      targetRowHeight: 80,
      gap: 0,
    });

    const snapshot = model.snapshot();
    expect(snapshot.layout.nodes).toHaveLength(2);
    expect(snapshot.layout.nodes[1].x + snapshot.layout.nodes[1].width).toBeCloseTo(180);
  });

  it("uses square fallback geometry when image metadata is unavailable", () => {
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
    for (const id of ["missing", "invalid"]) {
      const node = snapshot.layout.nodes.find((candidate) => candidate.mediaId === id)!;
      expect(node.width / node.height).toBeCloseTo(1);
    }
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

    expect(() => model.append("session-1", [media("b")])).toThrow(/terminal/i);
  });
});
