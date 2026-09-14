import { describe, expect, it } from "vitest";

import { MediaBrowserController } from "../src/application/browser/mediaBrowserController";
import { CanvasBrowserController } from "../src/application/canvas/canvasBrowserController";
import { CanvasSceneModel } from "../src/application/canvas/canvasSceneModel";
import { MediaSessionController } from "../src/application/mediaSession";
import type {
  MediaRepresentationPort,
  ThumbnailRepresentation,
  ThumbnailRequest,
} from "../src/application/ports/mediaRepresentation";
import type { MediaResourcePort } from "../src/application/ports/mediaResource";
import type {
  MediaItem,
  MediaScanEvent,
  MediaScanPort,
  MediaScanRequest,
} from "../src/application/ports/mediaScan";
import type {
  PickedSource,
  SourcePickerPort,
} from "../src/application/ports/sourcePicker";
import { RepresentationScheduler } from "../src/application/resources/representationScheduler";

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

class SingleSourcePicker implements SourcePickerPort {
  async pickDirectory(): Promise<PickedSource> {
    return {
      source: { id: "source-1", locator: "local-source/1" },
      displayName: "Gallery",
    };
  }
}

class TrackingRepresentationPort implements MediaRepresentationPort {
  readonly calls: ThumbnailRequest[] = [];
  readonly releases: string[] = [];

  async requestThumbnail(
    request: ThumbnailRequest,
  ): Promise<ThumbnailRepresentation> {
    this.calls.push({ ...request });
    return {
      resourceKey: this.derivedKey(request),
      width: request.maxEdge,
      height: request.maxEdge,
    };
  }

  async releaseRepresentation(resourceKey: string): Promise<void> {
    this.releases.push(resourceKey);
  }

  derivedKey(request: ThumbnailRequest): string {
    return `derived-${request.resourceKey}-${request.maxEdge}`;
  }
}

class FakeResourcePort implements MediaResourcePort {
  uriFor(resourceKey: string): string {
    return `test-media://${resourceKey}`;
  }
}

function media(index: number): MediaItem {
  return {
    id: `media-${index}`,
    sourceId: "source-1",
    name: `media-${index}.jpg`,
    relativePath: `media-${index}.jpg`,
    kind: "image",
    fileSize: 100 + index,
    modifiedAtMs: index,
    visual: { width: 100, height: 100 },
    resourceKey: `1/${index + 1}`,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("representation lease consumers", () => {
  it("keeps Flow thumbnails warm outside the render window and reuses them on return", async () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const representations = new TrackingRepresentationPort();
    const browser = new MediaBrowserController(
      {
        sessionController: sessions,
        sourcePicker: new SingleSourcePicker(),
        representationScheduler: new RepresentationScheduler(representations, {
          maxConcurrent: 32,
        }),
        resourcePort: new FakeResourcePort(),
      },
      {
        gap: 10,
        minColumnWidth: 100,
        maxColumns: 4,
        overscanPx: 0,
        warmThumbnailCount: 64,
      },
    );

    browser.setViewport({
      width: 220,
      height: 210,
      scrollTop: 0,
      devicePixelRatio: 1,
    });
    await browser.pickAndOpenSource();
    scanPort.emit(0, { event: "started", data: { sessionId: "session-1" } });
    scanPort.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: Array.from({ length: 40 }, (_, index) => media(index)),
      },
    });
    await flushMicrotasks();

    const firstWindowIds = new Set(browser.snapshot.tiles.map((tile) => tile.mediaId));
    const initialCallCount = representations.calls.length;
    expect(firstWindowIds.size).toBeGreaterThan(0);
    expect(representations.releases).toEqual([]);

    browser.setViewport({
      width: 220,
      height: 210,
      scrollTop: 1200,
      devicePixelRatio: 1,
    });
    await flushMicrotasks();

    expect(representations.releases).toEqual([]);

    browser.setViewport({
      width: 220,
      height: 210,
      scrollTop: 0,
      devicePixelRatio: 1,
    });
    await flushMicrotasks();

    expect(browser.snapshot.tiles.some((tile) => firstWindowIds.has(tile.mediaId))).toBe(true);
    expect(representations.calls.length).toBeGreaterThan(initialCallCount);
    const firstWindowResourceKeys = new Set(
      [...firstWindowIds].map((mediaId) => {
        const index = Number(mediaId.replace("media-", ""));
        return `1/${index + 1}`;
      }),
    );
    const repeatCalls = representations.calls
      .slice(initialCallCount)
      .filter((request) => firstWindowResourceKeys.has(request.resourceKey));
    expect(repeatCalls).toEqual([]);

    browser.dispose();
    await flushMicrotasks();
    expect(representations.releases.length).toBeGreaterThan(0);
  });

  it("releases the previous Canvas LOD lease and the final lease on dispose", async () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const representations = new TrackingRepresentationPort();
    const scene = new CanvasSceneModel({
      atlas: {
        worldWidth: 1000,
        itemHeight: 100,
        gap: 10,
        minItemWidth: 25,
      },
      viewport: {
        overscanPx: 0,
        cellSize: 100,
        thumbnailMinEdgePx: 48,
        detailMinEdgePx: 180,
        camera: {
          viewport: { width: 400, height: 300 },
          zoom: 1,
        },
      },
    });
    const browser = new CanvasBrowserController(
      {
        sessionController: sessions,
        sourcePicker: new SingleSourcePicker(),
        representationScheduler: new RepresentationScheduler(representations),
        resourcePort: new FakeResourcePort(),
        scene,
      },
      {
        renderOverscanPx: 100,
        maxThumbnailEdge: 256,
        maxDetailEdge: 1024,
      },
    );

    browser.setViewport({ width: 400, height: 300, devicePixelRatio: 1 });
    await browser.pickAndOpenSource();
    scanPort.emit(0, { event: "started", data: { sessionId: "session-1" } });
    scanPort.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [media(0)] },
    });
    await flushMicrotasks();

    expect(representations.calls).toHaveLength(1);
    const thumbnailKey = representations.derivedKey(representations.calls[0]);
    expect(representations.releases).toEqual([]);

    browser.zoomAtScreen(2, { x: 200, y: 150 });
    await flushMicrotasks();

    expect(representations.calls.length).toBeGreaterThan(1);
    expect(representations.releases).toEqual([thumbnailKey]);
    const detailKey = representations.derivedKey(
      representations.calls[representations.calls.length - 1],
    );

    browser.dispose();
    await flushMicrotasks();
    expect(representations.releases).toEqual([thumbnailKey, detailKey]);
  });
});
