import { describe, expect, it } from "vitest";

import {
  MediaBrowserController,
  type MediaBrowserOptions,
} from "../src/application/browser/mediaBrowserController";
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

  emit(event: MediaScanEvent): void {
    this.listeners[0](event);
  }
}

class FakeSourcePicker implements SourcePickerPort {
  async pickDirectory(): Promise<PickedSource> {
    return {
      source: { id: "source-1", locator: "local-source/11" },
      displayName: "Gallery",
    };
  }
}

class ImmediateRepresentationPort implements MediaRepresentationPort {
  async requestThumbnail(
    request: ThumbnailRequest,
  ): Promise<ThumbnailRepresentation> {
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

function createBrowser(options: MediaBrowserOptions = {}) {
  const scanPort = new FakeScanPort();
  const browser = new MediaBrowserController(
    {
      sessionController: new MediaSessionController(scanPort, () => "session-1"),
      sourcePicker: new FakeSourcePicker(),
      representationScheduler: new RepresentationScheduler(
        new ImmediateRepresentationPort(),
        { maxConcurrent: 16 },
      ),
      resourcePort: new FakeResourcePort(),
    },
    {
      gap: 10,
      minColumnWidth: 100,
      maxColumns: 4,
      justifiedTargetRowHeight: 100,
      overscanPx: 0,
      ...options,
    },
  );
  return { browser, scanPort };
}

function media(index: number): MediaItem {
  return {
    id: `media-${index}`,
    sourceId: "source-1",
    name: `media-${index}.jpg`,
    relativePath: `media-${index}.jpg`,
    kind: "image",
    fileSize: 100,
    modifiedAtMs: index,
    visual: { width: 100, height: 100 },
    resourceKey: `1/${index + 1}`,
  };
}

function finishedSummary(itemCount: number) {
  return {
    discoveredFiles: itemCount,
    acceptedMedia: itemCount,
    emittedBatches: 1,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("MediaBrowserController layout modes", () => {
  it("switches completed media between masonry and justified without rescanning", async () => {
    const { browser, scanPort } = createBrowser();
    browser.setViewport({
      width: 220,
      height: 500,
      scrollTop: 0,
      devicePixelRatio: 1,
    });
    await browser.pickAndOpenSource();
    scanPort.emit({ event: "started", data: { sessionId: "session-1" } });
    scanPort.emit({
      event: "batch",
      data: {
        sessionId: "session-1",
        items: Array.from({ length: 6 }, (_, index) => media(index)),
      },
    });
    scanPort.emit({
      event: "finished",
      data: { sessionId: "session-1", summary: finishedSummary(6) },
    });
    await flushMicrotasks();

    const masonry = browser.snapshot;
    expect(masonry.layoutMode).toBe("masonry");
    expect(scanPort.requests).toHaveLength(1);
    expect(masonry.tiles).toHaveLength(6);

    browser.setLayoutMode("justified");
    await flushMicrotasks();
    const justified = browser.snapshot;

    expect(justified.layoutMode).toBe("justified");
    expect(justified.sessionId).toBe(masonry.sessionId);
    expect(justified.itemCount).toBe(6);
    expect(scanPort.requests).toHaveLength(1);
    expect(justified.tiles).toHaveLength(6);
    expect(justified.tiles[0].height).not.toBeCloseTo(masonry.tiles[0].height);

    browser.setLayoutMode("masonry");
    expect(browser.snapshot.layoutMode).toBe("masonry");
    expect(scanPort.requests).toHaveLength(1);
    browser.dispose();
  });

  it("keeps an unfinished justified tail hidden until the scan is terminal", async () => {
    const { browser, scanPort } = createBrowser({
      initialLayoutMode: "justified",
    });
    browser.setViewport({
      width: 300,
      height: 300,
      scrollTop: 0,
      devicePixelRatio: 1,
    });
    await browser.pickAndOpenSource();
    scanPort.emit({ event: "started", data: { sessionId: "session-1" } });
    scanPort.emit({
      event: "batch",
      data: { sessionId: "session-1", items: [media(0), media(1)] },
    });

    expect(browser.snapshot.itemCount).toBe(2);
    expect(browser.snapshot.layoutItemCount).toBe(0);
    expect(browser.snapshot.tiles).toEqual([]);

    scanPort.emit({
      event: "finished",
      data: { sessionId: "session-1", summary: finishedSummary(2) },
    });
    await flushMicrotasks();

    expect(browser.snapshot.layoutItemCount).toBe(2);
    expect(browser.snapshot.tiles).toHaveLength(2);
    browser.dispose();
  });

  it("can switch into justified mode mid-scan and emits the row once it fills", async () => {
    const { browser, scanPort } = createBrowser();
    browser.setViewport({
      width: 300,
      height: 300,
      scrollTop: 0,
      devicePixelRatio: 1,
    });
    await browser.pickAndOpenSource();
    scanPort.emit({ event: "started", data: { sessionId: "session-1" } });
    scanPort.emit({
      event: "batch",
      data: { sessionId: "session-1", items: [media(0), media(1)] },
    });

    browser.setLayoutMode("justified");
    expect(browser.snapshot.layoutMode).toBe("justified");
    expect(browser.snapshot.layoutItemCount).toBe(0);

    scanPort.emit({
      event: "batch",
      data: { sessionId: "session-1", items: [media(2)] },
    });
    await flushMicrotasks();

    expect(browser.snapshot.layoutItemCount).toBe(3);
    expect(browser.snapshot.tiles).toHaveLength(3);
    expect(scanPort.requests).toHaveLength(1);
    browser.dispose();
  });
});
