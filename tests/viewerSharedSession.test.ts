import { describe, expect, it } from "vitest";

import type {
  MediaDetail,
  MediaDetailPort,
  MediaDetailRequest,
} from "../src/application/ports/mediaDetail";
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
import { createViewerRuntime } from "../src/bootstrap/viewerRuntime";

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

class NullDetailPort implements MediaDetailPort {
  async getDetail(_request: MediaDetailRequest): Promise<MediaDetail | null> {
    return null;
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("shared viewer workspace integration", () => {
  it("feeds flow and canvas from one runtime, source pick and scan session", async () => {
    const scanPort = new FakeScanPort();
    const picker = new SingleSourcePicker();
    const runtime = createViewerRuntime(
      {
        scan: scanPort,
        sourcePicker: picker,
        representation: new ImmediateRepresentationPort(),
        resource: new FakeResourcePort(),
        detail: new NullDetailPort(),
      },
      {
        sessionIdFactory: () => "session-1",
        representationMaxConcurrent: 8,
      },
    );
    const canvas = runtime.createCanvasBrowser();

    runtime.flowBrowser.setViewport({
      width: 500,
      height: 400,
      scrollTop: 0,
      devicePixelRatio: 1,
    });
    canvas.setViewport({ width: 500, height: 400, devicePixelRatio: 1 });

    await runtime.workspace.pickAndOpenSource();
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

    expect(runtime.workspace.snapshot).toMatchObject({
      sourceDisplayName: "Shared Gallery",
      sessionId: "session-1",
      itemCount: 3,
    });
    expect(runtime.sessionController.current?.id).toBe("session-1");
    expect(runtime.query.snapshot.matchedItemCount).toBe(3);
    expect(runtime.flowBrowser.snapshot.sessionId).toBe("session-1");
    expect(runtime.flowBrowser.snapshot.itemCount).toBe(3);
    expect(canvas.snapshot.sessionId).toBe("session-1");
    expect(canvas.snapshot.itemCount).toBe(3);
    expect(scanPort.requests).toHaveLength(1);

    runtime.flowBrowser.setLayoutMode("justified");
    expect(runtime.flowBrowser.snapshot.layoutMode).toBe("justified");
    expect(scanPort.requests).toHaveLength(1);

    canvas.panByScreen({ x: -60, y: 20 });
    const cameraBeforeDispose = canvas.snapshot.camera;
    canvas.dispose();

    const remountedCanvas = runtime.createCanvasBrowser();
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
    runtime.dispose();
    runtime.dispose();
  });
});
