import { describe, expect, it } from "vitest";

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

  emit(scanIndex: number, event: MediaScanEvent): void {
    this.listeners[scanIndex](event);
  }
}

class QueueSourcePicker implements SourcePickerPort {
  constructor(private readonly sources: PickedSource[]) {}

  async pickDirectory(): Promise<PickedSource | null> {
    return this.sources.shift() ?? null;
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

interface PendingRepresentation {
  request: ThumbnailRequest;
  resolve: (value: ThumbnailRepresentation) => void;
  reject: (reason: unknown) => void;
}

class ControlledRepresentationPort implements MediaRepresentationPort {
  readonly pending: PendingRepresentation[] = [];

  requestThumbnail(request: ThumbnailRequest): Promise<ThumbnailRepresentation> {
    return new Promise((resolve, reject) => {
      this.pending.push({ request: { ...request }, resolve, reject });
    });
  }
}

class FakeResourcePort implements MediaResourcePort {
  uriFor(resourceKey: string): string {
    return `test-media://${resourceKey}`;
  }
}

function sessionIds(...ids: string[]) {
  const queue = [...ids];
  return () => {
    const id = queue.shift();
    if (id === undefined) {
      throw new Error("session id queue exhausted");
    }
    return id;
  };
}

function media(
  index: number,
  kind: MediaItem["kind"] = "image",
): MediaItem {
  return {
    id: `media-${index}`,
    sourceId: "source-1",
    name: `media-${index}.jpg`,
    relativePath: `media-${index}.jpg`,
    kind,
    fileSize: 100,
    modifiedAtMs: index,
    visual: { width: 100, height: 100 },
    resourceKey: `1/${index + 1}`,
  };
}

function createScene(initialZoom = 1) {
  return new CanvasSceneModel({
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
        viewport: { width: 100, height: 100 },
        zoom: initialZoom,
      },
    },
  });
}

function createBrowser(
  representationPort: MediaRepresentationPort = new ImmediateRepresentationPort(),
  initialZoom = 1,
  sessionIdValues = ["session-1"],
) {
  const scanPort = new FakeScanPort();
  const sessionController = new MediaSessionController(
    scanPort,
    sessionIds(...sessionIdValues),
  );
  const scene = createScene(initialZoom);
  const browser = new CanvasBrowserController(
    {
      sessionController,
      sourcePicker: new QueueSourcePicker([
        {
          source: { id: "source-1", locator: "local-source/1" },
          displayName: "First",
        },
        {
          source: { id: "source-2", locator: "local-source/2" },
          displayName: "Second",
        },
      ]),
      representationScheduler: new RepresentationScheduler(representationPort, {
        maxConcurrent: 16,
      }),
      resourcePort: new FakeResourcePort(),
      scene,
    },
    {
      renderOverscanPx: 100,
      maxThumbnailEdge: 256,
      maxDetailEdge: 1024,
    },
  );
  return { browser, scanPort, representationPort, scene };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("CanvasBrowserController", () => {
  it("does not decode placeholder LOD media until zoom makes it useful", async () => {
    const representationPort = new ImmediateRepresentationPort();
    const { browser, scanPort } = createBrowser(representationPort, 0.25);
    browser.setViewport({ width: 100, height: 100, devicePixelRatio: 2 });
    await browser.pickAndOpenSource();
    scanPort.emit(0, { event: "started", data: { sessionId: "session-1" } });
    scanPort.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [media(0)] },
    });

    expect(browser.snapshot.items).toHaveLength(1);
    expect(browser.snapshot.items[0].lod).toBe("placeholder");
    expect(browser.snapshot.items[0].representationStatus).toBe("placeholder");
    expect(representationPort.calls).toEqual([]);

    browser.zoomAtScreen(1, { x: 50, y: 50 });
    await flushMicrotasks();

    expect(representationPort.calls).toEqual([
      { resourceKey: "1/1", maxEdge: 200 },
    ]);
    expect(browser.snapshot.items[0].lod).toBe("thumbnail");
    expect(browser.snapshot.items[0].representationUri).toBe(
      "test-media://derived-1/1-200",
    );
    browser.dispose();
  });

  it("requests a larger representation when an item enters detail LOD", async () => {
    const representationPort = new ImmediateRepresentationPort();
    const { browser, scanPort } = createBrowser(representationPort);
    browser.setViewport({ width: 400, height: 300, devicePixelRatio: 2 });
    await browser.pickAndOpenSource();
    scanPort.emit(0, { event: "started", data: { sessionId: "session-1" } });
    scanPort.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [media(0)] },
    });
    await flushMicrotasks();

    expect(representationPort.calls[0]).toEqual({
      resourceKey: "1/1",
      maxEdge: 200,
    });

    browser.zoomAtScreen(2, { x: 200, y: 150 });
    await flushMicrotasks();

    expect(representationPort.calls.at(-1)).toEqual({
      resourceKey: "1/1",
      maxEdge: 400,
    });
    expect(browser.snapshot.items[0].lod).toBe("detail");
    browser.dispose();
  });

  it("marks overscan items lower priority while retaining them in the render set", async () => {
    const representationPort = new ImmediateRepresentationPort();
    const { browser, scanPort } = createBrowser(representationPort);
    browser.setViewport({ width: 100, height: 100, devicePixelRatio: 1 });
    await browser.pickAndOpenSource();
    scanPort.emit(0, { event: "started", data: { sessionId: "session-1" } });
    scanPort.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [media(0), media(1)] },
    });
    await flushMicrotasks();

    expect(browser.snapshot.items.map((item) => [item.mediaId, item.priority])).toEqual([
      ["media-0", "visible"],
      ["media-1", "overscan"],
    ]);
    browser.dispose();
  });

  it("does not send video or audio placeholders through the image representation port", async () => {
    const representationPort = new ImmediateRepresentationPort();
    const { browser, scanPort } = createBrowser(representationPort);
    browser.setViewport({ width: 400, height: 300, devicePixelRatio: 1 });
    await browser.pickAndOpenSource();
    scanPort.emit(0, { event: "started", data: { sessionId: "session-1" } });
    scanPort.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [media(0, "video"), media(1, "audio"), media(2)],
      },
    });
    await flushMicrotasks();

    expect(representationPort.calls).toEqual([
      { resourceKey: "1/3", maxEdge: 100 },
    ]);
    expect(
      browser.snapshot.items
        .filter((item) => item.kind !== "image")
        .map((item) => item.representationStatus),
    ).toEqual(["unsupported", "unsupported"]);
    browser.dispose();
  });

  it("drops stale representation completion after switching source sessions", async () => {
    const representationPort = new ControlledRepresentationPort();
    const { browser, scanPort } = createBrowser(
      representationPort,
      1,
      ["session-1", "session-2"],
    );
    browser.setViewport({ width: 400, height: 300, devicePixelRatio: 1 });
    await browser.pickAndOpenSource();
    scanPort.emit(0, { event: "started", data: { sessionId: "session-1" } });
    scanPort.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [media(0)] },
    });
    await flushMicrotasks();
    expect(representationPort.pending).toHaveLength(1);

    await browser.pickAndOpenSource();
    scanPort.emit(1, { event: "started", data: { sessionId: "session-2" } });
    scanPort.emit(1, {
      event: "batch",
      data: {
        sessionId: "session-2",
        items: [{ ...media(1), sourceId: "source-2" }],
      },
    });
    await flushMicrotasks();

    representationPort.pending[0].resolve({
      resourceKey: "stale-derived",
      width: 100,
      height: 100,
    });
    await flushMicrotasks();

    expect(browser.snapshot.sessionId).toBe("session-2");
    expect(browser.snapshot.sourceDisplayName).toBe("Second");
    expect(browser.snapshot.items.some((item) => item.mediaId === "media-0")).toBe(false);
    expect(
      browser.snapshot.items.some(
        (item) => item.representationUri === "test-media://stale-derived",
      ),
    ).toBe(false);
    browser.dispose();
  });

  it("fits the scene and exposes the resulting camera state", async () => {
    const { browser, scanPort } = createBrowser();
    browser.setViewport({ width: 600, height: 400, devicePixelRatio: 1 });
    await browser.pickAndOpenSource();
    scanPort.emit(0, { event: "started", data: { sessionId: "session-1" } });
    scanPort.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [media(0), media(1)] },
    });

    expect(browser.fitToContent(50)).toBe(true);
    expect(browser.snapshot.camera.center).toEqual({ x: 105, y: 50 });
    expect(browser.snapshot.camera.zoom).toBeCloseTo(500 / 210);
    browser.dispose();
  });

  it("validates representation budgets", () => {
    const scanPort = new FakeScanPort();
    const sessionController = new MediaSessionController(scanPort, () => "session-1");
    const scheduler = new RepresentationScheduler(new ImmediateRepresentationPort());

    expect(
      () =>
        new CanvasBrowserController(
          {
            sessionController,
            sourcePicker: new QueueSourcePicker([]),
            representationScheduler: scheduler,
            resourcePort: new FakeResourcePort(),
            scene: createScene(),
          },
          { maxThumbnailEdge: 1024, maxDetailEdge: 512 },
        ),
    ).toThrow(/maxDetailEdge/);
  });
});
