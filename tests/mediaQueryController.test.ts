import { describe, expect, it } from "vitest";

import {
  MediaIndex,
  MediaSessionController,
} from "../src/application/mediaSession";
import type { MediaResourcePort } from "../src/application/ports/mediaResource";
import type {
  MediaItem,
  MediaScanEvent,
  MediaScanPort,
  MediaScanRequest,
} from "../src/application/ports/mediaScan";
import { MediaQueryController } from "../src/application/query/mediaQueryController";
import { MediaActivationController } from "../src/application/viewer/mediaActivationController";

class FakeScanPort implements MediaScanPort {
  readonly listeners: Array<(event: MediaScanEvent) => void> = [];

  scan(
    _request: MediaScanRequest,
    onEvent: (event: MediaScanEvent) => void,
  ): Promise<void> {
    this.listeners.push(onEvent);
    return new Promise<void>(() => undefined);
  }

  async cancel(): Promise<boolean> {
    return true;
  }

  emit(index: number, event: MediaScanEvent): void {
    this.listeners[index](event);
  }
}

class FakeResourcePort implements MediaResourcePort {
  uriFor(resourceKey: string): string {
    return `test-media://${resourceKey}`;
  }
}

function media(id: string, kind: MediaItem["kind"]): MediaItem {
  return {
    id,
    sourceId: "source-1",
    name: id,
    relativePath: id,
    kind,
    fileSize: 1,
    modifiedAtMs: null,
    visual: null,
    resourceKey: `resource/${id}`,
  };
}

describe("MediaQueryController", () => {
  it("filters the shared media projection while preserving source order", () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const query = new MediaQueryController(sessions);

    sessions.openSource({ id: "source-1", locator: "source/1" });
    scanPort.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [
          media("image-1", "image"),
          media("video-1", "video"),
          media("animated-1", "animated-image"),
          media("audio-1", "audio"),
        ],
      },
    });

    expect(query.snapshot).toMatchObject({
      sessionId: "session-1",
      sourceItemCount: 4,
      matchedItemCount: 4,
    });
    expect(sessions.current?.items.ids()).toEqual([
      "image-1",
      "video-1",
      "animated-1",
      "audio-1",
    ]);

    expect(query.setIncludedKinds(["image", "animated-image"])).toBe(true);
    expect(query.snapshot).toMatchObject({
      sourceItemCount: 4,
      matchedItemCount: 2,
      includedKinds: ["image", "animated-image"],
    });
    expect(sessions.current?.items.ids()).toEqual(["image-1", "animated-1"]);
    expect(sessions.current?.items.get("video-1")).toBeUndefined();
    expect(sessions.current?.scanState.receivedItems).toBe(4);

    query.dispose();
  });

  it("processes new scan batches incrementally under an active filter", () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const query = new MediaQueryController(sessions);
    query.setIncludedKinds(["video"]);

    sessions.openSource({ id: "source-1", locator: "source/1" });
    scanPort.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [media("image-1", "image"), media("video-1", "video")],
      },
    });
    const revisionAfterFirstBatch = query.snapshot.projectionRevision;

    scanPort.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [media("audio-1", "audio"), media("video-2", "video")],
      },
    });

    expect(query.snapshot).toMatchObject({
      sourceItemCount: 4,
      matchedItemCount: 2,
      projectionRevision: revisionAfterFirstBatch,
    });
    expect(sessions.current?.items.ids()).toEqual(["video-1", "video-2"]);
    expect(sessions.current?.scanState.receivedItems).toBe(4);

    query.dispose();
  });

  it("keeps the query across source replacement", () => {
    const scanPort = new FakeScanPort();
    const ids = ["session-1", "session-2"];
    const sessions = new MediaSessionController(scanPort, () => ids.shift()!);
    const query = new MediaQueryController(sessions);
    query.setIncludedKinds(["audio"]);

    sessions.openSource({ id: "source-1", locator: "source/1" });
    scanPort.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [media("video-1", "video"), media("audio-1", "audio")],
      },
    });
    expect(sessions.current?.items.ids()).toEqual(["audio-1"]);

    sessions.openSource({ id: "source-2", locator: "source/2" });
    scanPort.emit(1, {
      event: "batch",
      data: {
        sessionId: "session-2",
        items: [media("image-2", "image"), media("audio-2", "audio")],
      },
    });

    expect(query.snapshot).toMatchObject({
      sessionId: "session-2",
      sourceItemCount: 2,
      matchedItemCount: 1,
      includedKinds: ["audio"],
    });
    expect(sessions.current?.items.ids()).toEqual(["audio-2"]);

    query.dispose();
  });

  it("makes explicit activation and adjacent navigation follow the filtered projection", () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const query = new MediaQueryController(sessions);
    const activation = new MediaActivationController(sessions, new FakeResourcePort());

    sessions.openSource({ id: "source-1", locator: "source/1" });
    scanPort.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [
          media("image-1", "image"),
          media("video-1", "video"),
          media("animated-1", "animated-image"),
          media("audio-1", "audio"),
        ],
      },
    });

    expect(activation.activate("video-1")).toBe(true);
    query.setIncludedKinds(["image", "animated-image"]);
    expect(activation.snapshot).toBeNull();
    expect(activation.activate("video-1")).toBe(false);

    expect(activation.activate("image-1")).toBe(true);
    expect(activation.snapshot).toMatchObject({
      position: 1,
      totalItems: 2,
      hasPrevious: false,
      hasNext: true,
    });
    expect(activation.activateNext()).toBe(true);
    expect(activation.snapshot).toMatchObject({
      mediaId: "animated-1",
      position: 2,
      totalItems: 2,
      hasPrevious: true,
      hasNext: false,
    });

    activation.dispose();
    query.dispose();
  });

  it("keeps a 50k source bounded to id projection data and rebuilds deterministically", () => {
    const index = new MediaIndex();
    const items = Array.from({ length: 50_000 }, (_, position) =>
      media(
        `media-${position}`,
        position % 4 === 0
          ? "image"
          : position % 4 === 1
            ? "animated-image"
            : position % 4 === 2
              ? "video"
              : "audio",
      ),
    );

    index.upsertMany(items);
    expect(index.sourceSize).toBe(50_000);
    expect(index.size).toBe(50_000);
    expect(index.indexOf("media-49")).toBe(49);

    index.setIncludedKinds(["video"]);
    expect(index.sourceSize).toBe(50_000);
    expect(index.size).toBe(12_500);
    expect(index.at(0)?.id).toBe("media-2");
    expect(index.at(12_499)?.id).toBe("media-49998");
    expect(index.indexOf("media-2")).toBe(0);
    expect(index.indexOf("media-3")).toBe(-1);
  });
});
