import { describe, expect, it } from "vitest";

import { CanvasViewportModel } from "../src/application/canvas/canvasViewportModel";

function node(
  mediaId: string,
  x: number,
  y: number,
  width = 100,
  height = 100,
) {
  return { mediaId, x, y, width, height };
}

describe("CanvasViewportModel", () => {
  it("returns only nodes intersecting the camera viewport", () => {
    const model = new CanvasViewportModel({
      overscanPx: 0,
      camera: { viewport: { width: 200, height: 200 } },
      cellSize: 100,
    });
    model.upsertNodes([
      node("visible", -25, -25, 50, 50),
      node("far", 250, -25, 50, 50),
    ]);

    expect(model.queryVisible().map((item) => item.node.mediaId)).toEqual([
      "visible",
    ]);
  });

  it("changes visible nodes when panning the camera", () => {
    const model = new CanvasViewportModel({
      overscanPx: 0,
      camera: { viewport: { width: 200, height: 200 } },
      cellSize: 100,
    });
    model.upsertNodes([
      node("origin", -25, -25, 50, 50),
      node("right", 175, -25, 50, 50),
    ]);

    model.panByScreen({ x: -200, y: 0 });

    expect(model.cameraSnapshot.center.x).toBe(200);
    expect(model.queryVisible().map((item) => item.node.mediaId)).toEqual([
      "right",
    ]);
  });

  it("uses projected screen size to select placeholder, thumbnail, and detail LOD", () => {
    const model = new CanvasViewportModel({
      overscanPx: 0,
      thumbnailMinEdgePx: 48,
      detailMinEdgePx: 768,
      camera: {
        viewport: { width: 400, height: 400 },
        zoom: 0.25,
      },
    });
    model.upsertNodes([node("media", -50, -50)]);
    const centerAnchor = { x: 200, y: 200 };

    expect(model.queryVisible()[0].lod).toBe("placeholder");

    model.zoomAtScreen(1, centerAnchor);
    expect(model.queryVisible()[0].lod).toBe("thumbnail");

    model.zoomAtScreen(8, centerAnchor);
    expect(model.queryVisible()[0].lod).toBe("detail");
  });

  it("includes nodes in screen-space overscan before they enter the viewport", () => {
    const model = new CanvasViewportModel({
      overscanPx: 50,
      camera: { viewport: { width: 200, height: 200 } },
    });
    model.upsertNodes([node("overscan", 120, -10, 20, 20)]);

    const result = model.queryVisible();
    expect(result).toHaveLength(1);
    expect(result[0].node.mediaId).toBe("overscan");
    expect(result[0].screenRect.x).toBe(220);
  });

  it("updates and removes world nodes incrementally", () => {
    const model = new CanvasViewportModel({
      overscanPx: 0,
      camera: { viewport: { width: 200, height: 200 } },
    });
    model.upsertNodes([node("media", 300, 0)]);
    expect(model.queryVisible()).toEqual([]);

    model.upsertNodes([node("media", -20, -20, 40, 40)]);
    expect(model.queryVisible()).toHaveLength(1);
    expect(model.removeNode("media")).toBe(true);
    expect(model.nodeCount).toBe(0);
    expect(model.queryVisible()).toEqual([]);
  });

  it("validates LOD thresholds", () => {
    expect(
      () =>
        new CanvasViewportModel({
          thumbnailMinEdgePx: 100,
          detailMinEdgePx: 50,
        }),
    ).toThrow(/detailMinEdgePx/);
  });
});
