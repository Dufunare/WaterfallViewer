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
import { ViewerWorkspaceController } from "../src/application/viewer/viewerWorkspaceController";

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

class SingleSourcePicker implements SourcePickerPort {
  calls = 0;

  async pickDirectory(): Promise<PickedSource | null> {
    this.calls += 1;
    return {
      source: { id: "source-1", locator: "local-source/1" },
      displayName: "Shared Gallery",
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

function media(index: number): MediaItem {
  return {
    id: `media-${index}`,
    sourceId: "source-1",
    name: `media-${index}.jpg`,
    relativePath: `media-${index}.jpg`,
    kind: "image",
    fileSize: 100,
    modifiedAtMs: index,
    visual: { width: 100 + index * 20, height: 100 },
    resourceKey: `1/${index + 1}`,
  };
}

function createScene(): CanvasSceneModel {
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
      detailMinEdgePx: 500,
      camera: { viewport: { width: 1, height: 1 } },
    },
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("shared viewer workspace integration", () => {
  it("feeds flow and canvas from one source pick and one scan session", async () => {
    const scanPort = new FakeScanPort();
    const picker = new SingleSourcePicker();
    const sessionController = new MediaSessionController(
      scanPort,
      () => "session-1",
    );
    const scheduler = new RepresentationScheduler(
      new ImmediateRepresentationPort(),
      { maxConcurrent: 8 },
    );
    const resourcePort = new FakeResourcePort();
    const workspace = new ViewerWorkspaceController(sessionController, picker);
    const flow = new MediaBrowserController({
      sessionController,
      sourcePicker: picker,
      representationScheduler: scheduler,
      resourcePort,
    });
    const scene = createScene();
    const createCanvas = () =>
      new CanvasBrowserController({
        sessionController,
        sourcePicker: picker,
        representationScheduler: scheduler,
        resourcePort,
        scene,
      });
    const canvas = createCanvas();

    flow.setViewport({
      width: 500,
      height: 400,
      scrollTop: 0,
      devicePixelRatio: 1,
    });
    canvas.setViewport({ width: 500, height: 400, devicePixelRatio: 1 });

    await workspace.pickAndOpenSource();
    expect(picker.calls).toBe(1);
    expect(scanPort.requests).toHaveLength(1);

    scanPort.emit({ event: "started", data: { sessionId: "session-1" } });
    scanPort.emit({
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [media(0), media(1), media(2)],
      },
    });
    scanPort.emit({
      event: "finished",
      data: {
        sessionId: "session-1",
        summary: {
          discoveredFiles: 3,
          acceptedMedia: 3,
          emittedBatches: 1,
        },
      },
    });
    await flushMicrotasks();

    expect(workspace.snapshot).toMatchObject({
      sourceDisplayName: "Shared Gallery",
      sessionId: "session-1",
      itemCount: 3,
    });
    expect(flow.snapshot.sessionId).toBe("session-1");
    expect(flow.snapshot.itemCount).toBe(3);
    expect(canvas.snapshot.sessionId).toBe("session-1");
    expect(canvas.snapshot.itemCount).toBe(3);
    expect(scanPort.requests).toHaveLength(1);

    flow.setLayoutMode("justified");
    expect(flow.snapshot.layoutMode).toBe("justified");
    expect(scanPort.requests).toHaveLength(1);

    canvas.panByScreen({ x: -60, y: 20 });
    const cameraBeforeDispose = canvas.snapshot.camera;
    canvas.dispose();

    const remountedCanvas = createCanvas();
    remountedCanvas.setViewport({
      width: 500,
      height: 400,
      devicePixelRatio: 1,
    });
    await flushMicrotasks();

    expect(remountedCanvas.snapshot.sessionId).toBe("session-1");
    expect(remountedCanvas.snapshot.itemCount).toBe(3);
    expect(remountedCanvas.snapshot.camera.center).toEqual(
      cameraBeforeDispose.center,
    );
    expect(scanPort.requests).toHaveLength(1);
    expect(picker.calls).toBe(1);

    remountedCanvas.dispose();
    flow.dispose();
    workspace.dispose();
  });
});
