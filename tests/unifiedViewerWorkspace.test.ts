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
  readonly scans: Array<{
    request: MediaScanRequest;
    onEvent: (event: MediaScanEvent) => void;
  }> = [];

  scan(
    request: MediaScanRequest,
    onEvent: (event: MediaScanEvent) => void,
  ): Promise<void> {
    this.scans.push({ request, onEvent });
    return new Promise<void>(() => undefined);
  }

  async cancel(): Promise<boolean> {
    return true;
  }

  emit(index: number, event: MediaScanEvent): void {
    this.scans[index].onEvent(event);
  }
}

class SingleSourcePicker implements SourcePickerPort {
  readonly calls: number[] = [];

  async pickDirectory(): Promise<PickedSource | null> {
    this.calls.push(this.calls.length + 1);
    return {
      source: { id: "source-1", locator: "local-source/1" },
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

function media(index: number): MediaItem {
  return {
    id: `media-${index}`,
    sourceId: "source-1",
    name: `media-${index}.jpg`,
    relativePath: `media-${index}.jpg`,
    kind: "image",
    fileSize: 100 + index,
    modifiedAtMs: index,
    visual: { width: 160 + index * 20, height: 100 },
    resourceKey: `1/${index + 1}`,
  };
}

describe("unified viewer workspace", () => {
  it("lets flow and lazily-created canvas consume one shared media session without rescanning", async () => {
    const scanPort = new FakeScanPort();
    const sessionController = new MediaSessionController(scanPort, () => "session-1");
    const sourcePicker = new SingleSourcePicker();
    const representationScheduler = new RepresentationScheduler(
      new ImmediateRepresentationPort(),
      { maxConcurrent: 8 },
    );
    const resourcePort = new FakeResourcePort();
    const workspace = new ViewerWorkspaceController(
      sessionController,
      sourcePicker,
    );
    const flowBrowser = new MediaBrowserController({
      sessionController,
      sourcePicker,
      representationScheduler,
      resourcePort,
    });

    flowBrowser.setViewport({
      width: 640,
      height: 480,
      scrollTop: 0,
      devicePixelRatio: 1,
    });

    await expect(workspace.pickAndOpenSource()).resolves.toBe(true);
    expect(sourcePicker.calls).toHaveLength(1);
    expect(scanPort.scans).toHaveLength(1);

    scanPort.emit(0, {
      event: "started",
      data: { sessionId: "session-1" },
    });
    scanPort.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [media(0), media(1), media(2)],
      },
    });
    scanPort.emit(0, {
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

    expect(workspace.snapshot.sessionId).toBe("session-1");
    expect(workspace.snapshot.itemCount).toBe(3);
    expect(flowBrowser.snapshot.sessionId).toBe("session-1");
    expect(flowBrowser.snapshot.itemCount).toBe(3);
    expect(flowBrowser.snapshot.layoutItemCount).toBe(3);

    flowBrowser.setLayoutMode("justified");
    expect(flowBrowser.snapshot.layoutMode).toBe("justified");
    expect(flowBrowser.snapshot.layoutItemCount).toBe(3);
    expect(scanPort.scans).toHaveLength(1);
    expect(sourcePicker.calls).toHaveLength(1);

    const scene = new CanvasSceneModel({
      atlas: {
        worldWidth: 1200,
        itemHeight: 180,
        gap: 12,
        minItemWidth: 60,
      },
      viewport: {
        overscanPx: 0,
        cellSize: 256,
        thumbnailMinEdgePx: 48,
        detailMinEdgePx: 720,
      },
    });
    const canvasBrowser = new CanvasBrowserController(
      {
        sessionController,
        sourcePicker,
        representationScheduler,
        resourcePort,
        scene,
      },
      { renderOverscanPx: 128 },
    );
    canvasBrowser.setViewport({
      width: 640,
      height: 480,
      devicePixelRatio: 1,
    });

    expect(canvasBrowser.snapshot.sessionId).toBe("session-1");
    expect(canvasBrowser.snapshot.itemCount).toBe(3);
    expect(canvasBrowser.snapshot.sceneNodeCount).toBe(3);
    expect(canvasBrowser.snapshot.items.length).toBeGreaterThan(0);
    expect(scanPort.scans).toHaveLength(1);
    expect(sourcePicker.calls).toHaveLength(1);

    canvasBrowser.dispose();
    flowBrowser.dispose();
    workspace.dispose();
  });
});
