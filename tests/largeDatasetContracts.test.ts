import { describe, expect, it } from "vitest";

import { MediaBrowserController } from "../src/application/browser/mediaBrowserController";
import { CanvasSceneModel } from "../src/application/canvas/canvasSceneModel";
import { JustifiedFlowModel } from "../src/application/flow/justifiedFlowModel";
import { MasonryFlowModel } from "../src/application/flow/masonryFlowModel";
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
import type { SourcePickerPort } from "../src/application/ports/sourcePicker";
import { RepresentationScheduler } from "../src/application/resources/representationScheduler";

const LARGE_MEDIA_COUNT = 50_000;
const STREAM_BATCH_SIZE = 64;
const TEST_TIMEOUT_MS = 30_000;

function mediaItem(index: number): MediaItem {
  const width = 240 + ((index * 97) % 1760);
  const height = 180 + ((index * 53) % 1020);
  return {
    id: `media-${index}`,
    sourceId: "source-large",
    name: `media-${index}.jpg`,
    relativePath: `nested/${Math.floor(index / 1000)}/media-${index}.jpg`,
    kind: "image",
    fileSize: 1024 + index,
    modifiedAtMs: index,
    visual: { width, height },
    resourceKey: `large/${index + 1}`,
  };
}

function mediaBatch(start: number, count: number): MediaItem[] {
  return Array.from({ length: count }, (_, offset) => mediaItem(start + offset));
}

function streamIntoFlow(
  syncFirst: (items: readonly MediaItem[]) => void,
  append: (items: readonly MediaItem[]) => void,
): void {
  const firstCount = Math.min(STREAM_BATCH_SIZE, LARGE_MEDIA_COUNT);
  syncFirst(mediaBatch(0, firstCount));
  for (let start = firstCount; start < LARGE_MEDIA_COUNT; start += STREAM_BATCH_SIZE) {
    append(mediaBatch(start, Math.min(STREAM_BATCH_SIZE, LARGE_MEDIA_COUNT - start)));
  }
}

describe("large dataset contracts", () => {
  it(
    "keeps masonry viewport work bounded after 50k incrementally streamed media",
    () => {
      const flow = new MasonryFlowModel({
        viewport: { width: 1440, height: 900 },
        columnCount: 6,
        gap: 10,
      });

      streamIntoFlow(
        (items) => flow.sync("large-session", items),
        (items) => flow.append("large-session", items),
      );

      expect(flow.itemCount).toBe(LARGE_MEDIA_COUNT);
      expect(flow.layoutItemCount).toBe(LARGE_MEDIA_COUNT);
      expect(flow.totalHeight).toBeGreaterThan(0);

      const visible = flow.queryVisible(
        {
          x: 0,
          y: flow.totalHeight / 2,
          width: 1440,
          height: 900,
        },
        { overscan: { top: 900, bottom: 900 } },
      );

      expect(visible.length).toBeGreaterThan(0);
      expect(visible.length).toBeLessThan(250);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps justified viewport work bounded after 50k incrementally streamed media",
    () => {
      const flow = new JustifiedFlowModel({
        viewport: { width: 1440, height: 900 },
        targetRowHeight: 220,
        gap: 10,
      });

      streamIntoFlow(
        (items) => flow.sync("large-session", items),
        (items) => flow.append("large-session", items),
      );
      flow.markTerminal();

      expect(flow.itemCount).toBe(LARGE_MEDIA_COUNT);
      expect(flow.layoutItemCount).toBe(LARGE_MEDIA_COUNT);
      expect(flow.pendingCount).toBe(0);
      expect(flow.totalHeight).toBeGreaterThan(0);

      const visible = flow.queryVisible(
        {
          x: 0,
          y: flow.totalHeight / 2,
          width: 1440,
          height: 900,
        },
        { overscan: { top: 900, bottom: 900 } },
      );

      expect(visible.length).toBeGreaterThan(0);
      expect(visible.length).toBeLessThan(250);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps free-canvas visibility local after indexing 50k stable world nodes",
    () => {
      const scene = new CanvasSceneModel({
        atlas: {
          worldWidth: 5000,
          itemHeight: 160,
          gap: 12,
          minItemWidth: 48,
        },
        viewport: {
          cellSize: 512,
          overscanPx: 256,
          thumbnailMinEdgePx: 48,
          detailMinEdgePx: 720,
        },
      });
      scene.setViewport({ width: 1440, height: 900 });

      streamIntoFlow(
        (items) => scene.sync("large-session", items),
        (items) => scene.append("large-session", items),
      );

      const snapshot = scene.snapshot();
      expect(snapshot.itemCount).toBe(LARGE_MEDIA_COUNT);
      expect(snapshot.nodeCount).toBe(LARGE_MEDIA_COUNT);
      expect(snapshot.bounds.height).toBeGreaterThan(0);

      scene.setCenter({
        x: snapshot.bounds.width / 2,
        y: snapshot.bounds.height / 2,
      });
      const renderSet = scene.queryVisible(512);

      expect(renderSet.length).toBeGreaterThan(0);
      expect(renderSet.length).toBeLessThan(500);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not let a 50k flow session expand DOM or decode work beyond the virtual window",
    async () => {
      const scanPort = new ControlledScanPort();
      const sessionController = new MediaSessionController(
        scanPort,
        () => "large-session",
      );
      const representationPort = new BlockingRepresentationPort();
      const browser = new MediaBrowserController(
        {
          sessionController,
          sourcePicker: new NeverSourcePicker(),
          representationScheduler: new RepresentationScheduler(representationPort, {
            maxConcurrent: 4,
          }),
          resourcePort: new FakeResourcePort(),
        },
        {
          gap: 10,
          minColumnWidth: 220,
          maxColumns: 8,
          overscanPx: 900,
        },
      );
      browser.setViewport({
        width: 1440,
        height: 900,
        scrollTop: 0,
        devicePixelRatio: 1,
      });

      sessionController.openSource(
        { id: "source-large", locator: "local-source/large" },
        STREAM_BATCH_SIZE,
      );
      scanPort.emit({ event: "started", data: { sessionId: "large-session" } });
      for (let start = 0; start < LARGE_MEDIA_COUNT; start += STREAM_BATCH_SIZE) {
        scanPort.emit({
          event: "batch",
          data: {
            sessionId: "large-session",
            items: mediaBatch(
              start,
              Math.min(STREAM_BATCH_SIZE, LARGE_MEDIA_COUNT - start),
            ),
          },
        });
      }

      await flushMicrotasks();

      const snapshot = browser.snapshot;
      expect(snapshot.itemCount).toBe(LARGE_MEDIA_COUNT);
      expect(snapshot.layoutItemCount).toBe(LARGE_MEDIA_COUNT);
      expect(snapshot.tiles.length).toBeGreaterThan(0);
      expect(snapshot.tiles.length).toBeLessThan(250);
      expect(representationPort.calls.length).toBeLessThanOrEqual(4);

      browser.dispose();
    },
    TEST_TIMEOUT_MS,
  );
});

class ControlledScanPort implements MediaScanPort {
  #listener: ((event: MediaScanEvent) => void) | null = null;

  scan(
    _request: MediaScanRequest,
    onEvent: (event: MediaScanEvent) => void,
  ): Promise<void> {
    this.#listener = onEvent;
    return new Promise<void>(() => undefined);
  }

  async cancel(): Promise<boolean> {
    return true;
  }

  emit(event: MediaScanEvent): void {
    if (this.#listener === null) {
      throw new Error("scan listener has not been registered");
    }
    this.#listener(event);
  }
}

class BlockingRepresentationPort implements MediaRepresentationPort {
  readonly calls: ThumbnailRequest[] = [];

  requestThumbnail(request: ThumbnailRequest): Promise<ThumbnailRepresentation> {
    this.calls.push({ ...request });
    return new Promise<ThumbnailRepresentation>(() => undefined);
  }
}

class NeverSourcePicker implements SourcePickerPort {
  async pickDirectory(): Promise<null> {
    throw new Error("large dataset contract must not invoke the source picker");
  }
}

class FakeResourcePort implements MediaResourcePort {
  uriFor(resourceKey: string): string {
    return `test-media://${resourceKey}`;
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
