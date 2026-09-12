import { describe, expect, it } from "vitest";

import { CanvasSceneModel } from "../src/application/canvas/canvasSceneModel";
import type { MediaItem } from "../src/application/ports/mediaScan";

function media(
  id: string,
  width: number | null = 100,
  height: number | null = 100,
  kind: MediaItem["kind"] = "image",
): MediaItem {
  return {
    id,
    sourceId: "source-1",
    name: `${id}.jpg`,
    relativePath: `nested/${id}.jpg`,
    kind,
    fileSize: 100,
    modifiedAtMs: null,
    visual:
      width === null || height === null
        ? null
        : { width, height },
    resourceKey: `1/${id.length}`,
  };
}

function createScene() {
  return new CanvasSceneModel({
    atlas: {
      worldWidth: 350,
      itemHeight: 100,
      gap: 10,
      minItemWidth: 25,
    },
    viewport: {
      overscanPx: 0,
      cellSize: 100,
      thumbnailMinEdgePx: 48,
      detailMinEdgePx: 768,
      camera: {
        viewport: { width: 1000, height: 1000 },
      },
    },
  });
}

describe("CanvasSceneModel", () => {
  it("keeps media with missing geometry discoverable through square fallbacks", () => {
    const scene = createScene();
    scene.sync("session-1", [
      media("image", 200, 100),
      media("audio", null, null, "audio"),
      media("invalid", 0, 100, "video"),
    ]);

    const snapshot = scene.snapshot();
    expect(snapshot.itemCount).toBe(3);
    expect(snapshot.nodeCount).toBe(3);
    expect(snapshot.fallbackAspectCount).toBe(2);

    const visible = scene.queryVisible();
    expect(visible.map((item) => item.mediaId)).toEqual([
      "image",
      "audio",
      "invalid",
    ]);
    expect(visible.find((item) => item.mediaId === "audio")?.worldRect).toMatchObject({
      width: 100,
      height: 100,
    });
  });

  it("appends new media without moving existing world nodes", () => {
    const scene = createScene();
    scene.sync("session-1", [media("a"), media("b")]);
    const before = new Map(
      scene.queryVisible().map((item) => [item.mediaId, item.worldRect]),
    );

    scene.append("session-1", [media("c"), media("d")]);
    const after = new Map(
      scene.queryVisible().map((item) => [item.mediaId, item.worldRect]),
    );

    expect(after.get("a")).toEqual(before.get("a"));
    expect(after.get("b")).toEqual(before.get("b"));
    expect(scene.snapshot().itemCount).toBe(4);
  });

  it("rebuilds changed geometry within a session while preserving the camera", () => {
    const scene = createScene();
    scene.sync("session-1", [media("a"), media("b")]);
    scene.setViewport({ width: 600, height: 400 });
    scene.setCenter({ x: 125, y: 75 });
    scene.zoomAtScreen(2, { x: 300, y: 200 });
    const cameraBefore = scene.cameraSnapshot;
    const widthBefore = scene
      .queryVisible()
      .find((item) => item.mediaId === "a")?.worldRect.width;

    scene.sync("session-1", [media("a", 200, 100), media("b")]);

    const cameraAfter = scene.cameraSnapshot;
    const widthAfter = scene
      .queryVisible()
      .find((item) => item.mediaId === "a")?.worldRect.width;
    expect(cameraAfter.center).toEqual(cameraBefore.center);
    expect(cameraAfter.zoom).toBe(cameraBefore.zoom);
    expect(cameraAfter.viewport).toEqual(cameraBefore.viewport);
    expect(widthBefore).toBe(100);
    expect(widthAfter).toBe(200);
  });

  it("resets camera position and zoom for a new source session while retaining viewport size", () => {
    const scene = createScene();
    scene.sync("session-1", [media("a")]);
    scene.setViewport({ width: 640, height: 480 });
    scene.setCenter({ x: 200, y: 150 });
    scene.zoomAtScreen(3, { x: 320, y: 240 });

    scene.sync("session-2", [media("new")]);

    expect(scene.cameraSnapshot.viewport).toEqual({ width: 640, height: 480 });
    expect(scene.cameraSnapshot.center).toEqual({ x: 0, y: 0 });
    expect(scene.cameraSnapshot.zoom).toBe(1);
    expect(scene.queryVisible().map((item) => item.mediaId)).toEqual(["new"]);
  });

  it("joins visible world nodes back to media metadata and lod", () => {
    const scene = createScene();
    scene.sync("session-1", [media("photo", 200, 100)]);

    const visible = scene.queryVisible();
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      mediaId: "photo",
      name: "photo.jpg",
      relativePath: "nested/photo.jpg",
      kind: "image",
      resourceKey: "1/5",
      lod: "thumbnail",
    });
    expect(visible[0].worldRect).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
  });

  it("fits content into the current viewport", () => {
    const scene = createScene();
    scene.setViewport({ width: 600, height: 400 });
    scene.sync("session-1", [media("a"), media("b")]);

    expect(scene.fitToContent(50)).toBe(true);

    const camera = scene.cameraSnapshot;
    expect(camera.center).toEqual({ x: 105, y: 50 });
    expect(camera.zoom).toBeCloseTo(500 / 210);
    expect(scene.queryVisible().map((item) => item.mediaId)).toEqual(["a", "b"]);
  });

  it("returns false when fitting an empty scene and validates excessive padding", () => {
    const scene = createScene();
    scene.setViewport({ width: 200, height: 100 });
    expect(scene.fitToContent()).toBe(false);

    scene.sync("session-1", [media("a")]);
    expect(() => scene.fitToContent(60)).toThrow(/no visible viewport area/);
  });

  it("rejects session-mismatched and duplicate appends", () => {
    const scene = createScene();
    scene.sync("session-1", [media("a")]);

    expect(() => scene.append("session-2", [media("b")])).toThrow(
      /active canvas scene/,
    );
    expect(() => scene.append("session-1", [media("a")])).toThrow(
      /duplicate media id/,
    );
  });
});
