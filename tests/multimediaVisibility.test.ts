import { describe, expect, it } from "vitest";

import { CanvasSceneModel } from "../src/application/canvas/canvasSceneModel";
import { JustifiedFlowModel } from "../src/application/flow/justifiedFlowModel";
import { MasonryFlowModel } from "../src/application/flow/masonryFlowModel";
import {
  mediaVisualFingerprint,
  projectMediaVisual,
} from "../src/application/mediaVisualProjection";
import type { MediaItem, MediaKind } from "../src/application/ports/mediaScan";

function media(
  id: string,
  kind: MediaKind,
  visual: MediaItem["visual"] = null,
): MediaItem {
  return {
    id,
    sourceId: "source-1",
    name: `${id}.${kind === "audio" ? "flac" : kind === "video" ? "mp4" : "jpg"}`,
    relativePath: `${id}`,
    kind,
    fileSize: 100,
    modifiedAtMs: null,
    visual,
    resourceKey: `1/${id}`,
  };
}

describe("multimedia browsing geometry", () => {
  it("uses deterministic lightweight fallbacks for video and audio only", () => {
    expect(projectMediaVisual(media("video", "video"))).toEqual({
      kind: "visual",
      width: 16,
      height: 9,
      source: "fallback",
    });
    expect(projectMediaVisual(media("audio", "audio"))).toEqual({
      kind: "visual",
      width: 1,
      height: 1,
      source: "fallback",
    });
    expect(projectMediaVisual(media("image", "image"))).toEqual({
      kind: "deferred",
      reason: "missing-visual",
    });
    expect(
      projectMediaVisual(media("broken", "animated-image", { width: 0, height: 10 })),
    ).toEqual({
      kind: "deferred",
      reason: "invalid-visual",
    });
  });

  it("changes the projection fingerprint when richer metadata replaces fallback geometry", () => {
    const fallback = media("video", "video");
    const metadata = media("video", "video", { width: 640, height: 480 });

    expect(mediaVisualFingerprint(fallback)).not.toBe(
      mediaVisualFingerprint(metadata),
    );
  });

  it("keeps video and audio visible in masonry while malformed images remain deferred", () => {
    const model = new MasonryFlowModel({
      viewport: { width: 220, height: 180 },
      columnCount: 2,
      gap: 20,
    });
    model.sync("session-1", [
      media("video", "video"),
      media("audio", "audio"),
      media("image", "image"),
    ]);

    const snapshot = model.snapshot();
    expect(snapshot.layout.nodes.map((node) => node.mediaId)).toEqual([
      "video",
      "audio",
    ]);
    expect(snapshot.deferredMedia).toEqual([
      { mediaId: "image", reason: "missing-visual" },
    ]);

    const videoNode = snapshot.layout.nodes[0];
    const audioNode = snapshot.layout.nodes[1];
    expect(videoNode.width / videoNode.height).toBeCloseTo(16 / 9);
    expect(audioNode.width / audioNode.height).toBeCloseTo(1);
  });

  it("keeps video and audio visible in justified rows and flushes them at terminal", () => {
    const model = new JustifiedFlowModel({
      viewport: { width: 600, height: 300 },
      targetRowHeight: 180,
      gap: 10,
    });
    model.sync(
      "session-1",
      [
        media("video", "video"),
        media("audio", "audio"),
        media("image", "image"),
      ],
      true,
    );

    const snapshot = model.snapshot();
    expect(snapshot.layout.nodes.map((node) => node.mediaId)).toEqual([
      "video",
      "audio",
    ]);
    expect(snapshot.deferredMedia).toEqual([
      { mediaId: "image", reason: "missing-visual" },
    ]);
    expect(snapshot.layout.pendingCount).toBe(0);
  });

  it("uses the same video/audio fallback ratios in canvas while retaining canvas-only image discoverability", () => {
    const scene = new CanvasSceneModel({
      atlas: {
        worldWidth: 1000,
        itemHeight: 180,
        gap: 10,
        minItemWidth: 45,
      },
      viewport: {
        overscanPx: 0,
        cellSize: 256,
        thumbnailMinEdgePx: 48,
        detailMinEdgePx: 720,
      },
    });
    scene.setViewport({ width: 1000, height: 400 });
    scene.sync("session-1", [
      media("video", "video"),
      media("audio", "audio"),
      media("image", "image"),
    ]);

    const snapshot = scene.snapshot();
    expect(snapshot.itemCount).toBe(3);
    expect(snapshot.nodeCount).toBe(3);
    expect(snapshot.fallbackAspectCount).toBe(3);

    const visible = scene.queryVisible(1000);
    const videoNode = visible.find((item) => item.mediaId === "video")!;
    const audioNode = visible.find((item) => item.mediaId === "audio")!;
    const imageNode = visible.find((item) => item.mediaId === "image")!;

    expect(videoNode.worldRect.width / videoNode.worldRect.height).toBeCloseTo(16 / 9);
    expect(audioNode.worldRect.width / audioNode.worldRect.height).toBeCloseTo(1);
    expect(imageNode.worldRect.width / imageNode.worldRect.height).toBeCloseTo(1);
  });

  it("rebuilds fallback flow geometry when video metadata becomes available", () => {
    const model = new MasonryFlowModel({
      viewport: { width: 220, height: 180 },
      columnCount: 1,
      gap: 10,
    });
    model.sync("session-1", [media("video", "video")]);
    const fallbackHeight = model.snapshot().layout.nodes[0].height;

    model.sync("session-1", [
      media("video", "video", { width: 640, height: 480 }),
    ]);
    const metadataHeight = model.snapshot().layout.nodes[0].height;

    expect(metadataHeight).not.toBe(fallbackHeight);
    expect(220 / metadataHeight).toBeCloseTo(4 / 3);
  });
});
