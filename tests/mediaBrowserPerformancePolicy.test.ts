import { describe, expect, it } from "vitest";

import { MediaBrowserController } from "../src/application/browser/mediaBrowserController";
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

  emit(event: MediaScanEvent): void {
    this.listeners[0](event);
  }
}

class SourcePicker implements SourcePickerPort {
  async pickDirectory(): Promise<PickedSource> {
    return {
      source: { id: "source-1", locator: "local-source/1" },
      displayName: "Gallery",
    };
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

class ResourcePort implements MediaResourcePort {
  uriFor(resourceKey: string): string {
    return `test-media://${resourceKey}`;
  }
}

function media(index: number, width = 100, height = 100): MediaItem {
  return {
    id: `media-${index}`,
    sourceId: "source-1",
    name: `media-${index}.jpg`,
    relativePath: `media-${index}.jpg`,
    kind: "image",
    fileSize: 1000 + index,
    modifiedAtMs: index,
    visual: { width, height },
    resourceKey: `1/${index + 1}`,
  };
}

function createBrowser() {
  const scan = new FakeScanPort();
  const representations = new ImmediateRepresentationPort();
  const browser = new MediaBrowserController(
    {
      sessionController: new MediaSessionController(scan, () => "session-1"),
      sourcePicker: new SourcePicker(),
      representationScheduler: new RepresentationScheduler(representations, {
        maxConcurrent: 64,
      }),
      resourcePort: new ResourcePort(),
    },
    {
      gap: 10,
      minColumnWidth: 100,
      maxColumns: 8,
      warmThumbnailCount: 64,
    },
  );
  return { browser, scan, representations };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

async function populate(
  browser: MediaBrowserController,
  scan: FakeScanPort,
  items: readonly MediaItem[],
): Promise<void> {
  await browser.pickAndOpenSource();
  scan.emit({ event: "started", data: { sessionId: "session-1" } });
  scan.emit({
    event: "batch",
    data: { sessionId: "session-1", items: [...items] },
  });
  await flushMicrotasks();
}

describe("MediaBrowserController performance policy", () => {
  it("renders one viewport of context but only prefetches out to two viewport heights", async () => {
    const { browser, scan, representations } = createBrowser();
    browser.setViewport({
      width: 220,
      height: 210,
      scrollTop: 0,
      devicePixelRatio: 1,
    });
    await populate(
      browser,
      scan,
      Array.from({ length: 100 }, (_, index) => media(index)),
    );

    const rendered = browser.snapshot.tiles.length;
    const requested = representations.calls.length;
    expect(rendered).toBeGreaterThan(0);
    expect(requested).toBeGreaterThan(rendered);
    expect(requested).toBeLessThan(100);

    browser.dispose();
  });

  it("uses bounded thumbnail buckets and never requests a Flow thumbnail above 1024", async () => {
    const { browser, scan, representations } = createBrowser();
    browser.setViewport({
      width: 900,
      height: 700,
      scrollTop: 0,
      devicePixelRatio: 2,
    });
    await populate(
      browser,
      scan,
      Array.from({ length: 30 }, (_, index) =>
        index === 0 ? media(index, 500, 5000) : media(index, 1600, 900),
      ),
    );

    expect(representations.calls.length).toBeGreaterThan(0);
    expect(
      representations.calls.every((request) =>
        [256, 512, 1024].includes(request.maxEdge),
      ),
    ).toBe(true);
    expect(Math.max(...representations.calls.map((request) => request.maxEdge))).toBeLessThanOrEqual(1024);

    browser.dispose();
  });

  it("supports fixed masonry columns and runtime justified row height without rescanning", async () => {
    const { browser, scan } = createBrowser();
    browser.setViewport({
      width: 660,
      height: 500,
      scrollTop: 0,
      devicePixelRatio: 1,
    });
    await populate(
      browser,
      scan,
      Array.from({ length: 20 }, (_, index) => media(index)),
    );

    browser.setColumnCount(2);
    const fixedColumns = browser.snapshot;
    expect(fixedColumns.columnCount).toBe(2);
    expect(new Set(fixedColumns.tiles.map((tile) => tile.x)).size).toBeLessThanOrEqual(2);

    browser.setColumnCount("auto");
    expect(browser.snapshot.columnCount).toBe("auto");

    browser.setLayoutMode("justified");
    browser.setJustifiedTargetRowHeight(160);
    await flushMicrotasks();
    expect(browser.snapshot.layoutMode).toBe("justified");
    expect(browser.snapshot.justifiedTargetRowHeight).toBe(160);
    expect(scan.listeners).toHaveLength(1);

    browser.dispose();
  });
});
