import { describe, expect, it } from "vitest";

import {
  MasonryBrowserController,
  type MasonryBrowserOptions,
} from "../src/application/browser/masonryBrowserController";
import { MediaSessionController } from "../src/application/mediaSession";
import type {
  MediaItem,
  MediaScanEvent,
  MediaScanPort,
  MediaScanRequest,
} from "../src/application/ports/mediaScan";
import type {
  MediaRepresentationPort,
  ThumbnailRepresentation,
  ThumbnailRequest,
} from "../src/application/ports/mediaRepresentation";
import type { MediaResourcePort } from "../src/application/ports/mediaResource";
import type {
  PickedSource,
  SourcePickerPort,
} from "../src/application/ports/sourcePicker";
import { RepresentationScheduler } from "../src/application/resources/representationScheduler";

class FakeScanPort implements MediaScanPort {
  readonly requests: MediaScanRequest[] = [];
  readonly listeners: Array<(event: MediaScanEvent) => void> = [];

  scan(
    request: MediaScanRequest,
    onEvent: (event: MediaScanEvent) => void,
  ): Promise<void> {
    this.requests.push(request);
    this.listeners.push(onEvent);
    return new Promise<void>(() => undefined);
  }

  async cancel(): Promise<boolean> {
    return true;
  }

  emit(event: MediaScanEvent, index = 0): void {
    this.listeners[index](event);
  }
}

class FakeSourcePicker implements SourcePickerPort {
  constructor(private readonly picked: PickedSource | null) {}

  async pickDirectory(): Promise<PickedSource | null> {
    return this.picked;
  }
}

class ImmediateRepresentationPort implements MediaRepresentationPort {
  readonly calls: ThumbnailRequest[] = [];

  async requestThumbnail(
    request: ThumbnailRequest,
  ): Promise<ThumbnailRepresentation> {
    this.calls.push({ ...request });
    return {
      resourceKey: `derived-${request.resourceKey}-${request.maxEdge}`,
      width: request.maxEdge,
      height: request.maxEdge,
    };
  }
}

class FakeResourcePort implements MediaResourcePort {
  uriFor(resourceKey: string): string {
    return `test-media://${resourceKey}`;
  }
}

function createBrowser(options: MasonryBrowserOptions = {}) {
  const scanPort = new FakeScanPort();
  const sessionController = new MediaSessionController(scanPort, () => "session-1");
  const representationPort = new ImmediateRepresentationPort();
  const scheduler = new RepresentationScheduler(representationPort, {
    maxConcurrent: 16,
  });
  const browser = new MasonryBrowserController(
    {
      sessionController,
      sourcePicker: new FakeSourcePicker({
        source: { id: "source-1", locator: "local-source/7" },
        displayName: "Pictures",
      }),
      representationScheduler: scheduler,
      resourcePort: new FakeResourcePort(),
    },
    {
      gap: 10,
      minColumnWidth: 100,
      maxColumns: 4,
      overscanPx: 0,
      ...options,
    },
  );

  return { browser, scanPort, representationPort };
}

function mediaItem(index: number, kind: MediaItem["kind"] = "image"): MediaItem {
  return {
    id: `media-${index}`,
    sourceId: "source-1",
    name: `media-${index}.jpg`,
    relativePath: `nested/media-${index}.jpg`,
    kind,
    fileSize: 100 + index,
    modifiedAtMs: index,
    visual: { width: 100, height: 100 },
    resourceKey: `1/${index + 1}`,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("MasonryBrowserController", () => {
  it("opens an opaque source descriptor and renders only the virtual window", async () => {
    const { browser, scanPort } = createBrowser();
    browser.setViewport({
      width: 220,
      height: 210,
      scrollTop: 0,
      devicePixelRatio: 1,
    });

    await expect(browser.pickAndOpenSource()).resolves.toBe(true);
    expect(scanPort.requests).toHaveLength(1);
    expect(scanPort.requests[0].source).toEqual({
      id: "source-1",
      locator: "local-source/7",
    });

    scanPort.emit({ event: "started", data: { sessionId: "session-1" } });
    scanPort.emit({
      event: "batch",
      data: {
        sessionId: "session-1",
        items: Array.from({ length: 20 }, (_, index) => mediaItem(index)),
      },
    });
    await flushMicrotasks();

    const snapshot = browser.snapshot;
    expect(snapshot.sourceDisplayName).toBe("Pictures");
    expect(snapshot.itemCount).toBe(20);
    expect(snapshot.layoutItemCount).toBe(20);
    expect(snapshot.tiles.length).toBeGreaterThan(0);
    expect(snapshot.tiles.length).toBeLessThan(20);
    expect(snapshot.tiles.every((tile) => tile.priority === "visible")).toBe(true);
    browser.dispose();
  });

  it("requests thumbnails only for renderable image tiles and exposes resource URIs", async () => {
    const { browser, scanPort, representationPort } = createBrowser({
      overscanPx: 100,
    });
    browser.setViewport({
      width: 220,
      height: 210,
      scrollTop: 0,
      devicePixelRatio: 2,
    });
    await browser.pickAndOpenSource();

    scanPort.emit({ event: "started", data: { sessionId: "session-1" } });
    scanPort.emit({
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [
          mediaItem(0),
          mediaItem(1, "animated-image"),
          mediaItem(2, "video"),
          ...Array.from({ length: 9 }, (_, index) => mediaItem(index + 3)),
        ],
      },
    });
    await flushMicrotasks();

    const snapshot = browser.snapshot;
    const videoTile = snapshot.tiles.find((tile) => tile.kind === "video");
    expect(videoTile?.thumbnailStatus).toBe("unsupported");
    expect(representationPort.calls.some((call) => call.resourceKey === "1/3")).toBe(false);

    const readyImage = snapshot.tiles.find(
      (tile) => tile.kind === "image" && tile.thumbnailStatus === "ready",
    );
    expect(readyImage?.thumbnailUri).toMatch(/^test-media:\/\/derived-/);
    expect(snapshot.tiles.some((tile) => tile.priority === "overscan")).toBe(true);
    browser.dispose();
  });

  it("replaces the rendered window as the viewport scrolls", async () => {
    const { browser, scanPort } = createBrowser();
    browser.setViewport({
      width: 220,
      height: 210,
      scrollTop: 0,
      devicePixelRatio: 1,
    });
    await browser.pickAndOpenSource();
    scanPort.emit({ event: "started", data: { sessionId: "session-1" } });
    scanPort.emit({
      event: "batch",
      data: {
        sessionId: "session-1",
        items: Array.from({ length: 40 }, (_, index) => mediaItem(index)),
      },
    });
    await flushMicrotasks();

    const firstWindow = new Set(browser.snapshot.tiles.map((tile) => tile.mediaId));
    browser.setViewport({
      width: 220,
      height: 210,
      scrollTop: 1200,
      devicePixelRatio: 1,
    });
    await flushMicrotasks();
    const secondWindow = new Set(browser.snapshot.tiles.map((tile) => tile.mediaId));

    expect(secondWindow.size).toBeGreaterThan(0);
    expect([...secondWindow].some((mediaId) => firstWindow.has(mediaId))).toBe(false);
    browser.dispose();
  });
});
