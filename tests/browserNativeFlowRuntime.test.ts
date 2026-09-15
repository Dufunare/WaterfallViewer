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
  listener: ((event: MediaScanEvent) => void) | null = null;

  scan(
    _request: MediaScanRequest,
    onEvent: (event: MediaScanEvent) => void,
  ): Promise<void> {
    this.listener = onEvent;
    return new Promise<void>(() => undefined);
  }

  async cancel(): Promise<boolean> {
    return true;
  }

  emit(event: MediaScanEvent): void {
    if (this.listener === null) {
      throw new Error("scan listener is not registered");
    }
    this.listener(event);
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

class TrackingDerivedRepresentationPort implements MediaRepresentationPort {
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

class NullDetailPort implements MediaDetailPort {
  async getDetail(_request: MediaDetailRequest): Promise<MediaDetail | null> {
    return null;
  }
}

function media(): MediaItem {
  return {
    id: "media-1",
    sourceId: "source-1",
    name: "large-photo.jpg",
    relativePath: "large-photo.jpg",
    kind: "image",
    fileSize: 8_000_000,
    modifiedAtMs: 1,
    visual: { width: 6000, height: 4000 },
    resourceKey: "1/1",
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("browser-native Flow runtime", () => {
  it("hands source resource keys directly to Flow without derived thumbnail work", async () => {
    const scan = new FakeScanPort();
    const derived = new TrackingDerivedRepresentationPort();
    const runtime = createViewerRuntime(
      {
        scan,
        sourcePicker: new SingleSourcePicker(),
        representation: derived,
        resource: new ResourcePort(),
        detail: new NullDetailPort(),
      },
      { sessionIdFactory: () => "session-1" },
    );

    runtime.flowBrowser.setViewport({
      width: 800,
      height: 600,
      scrollTop: 0,
      devicePixelRatio: 2,
    });
    await runtime.workspace.pickAndOpenSource();
    scan.emit({ event: "started", data: { sessionId: "session-1" } });
    scan.emit({
      event: "batch",
      data: { sessionId: "session-1", items: [media()] },
    });
    await flushMicrotasks();

    expect(derived.calls).toEqual([]);
    expect(runtime.flowBrowser.snapshot.tiles).toHaveLength(1);
    expect(runtime.flowBrowser.snapshot.tiles[0]).toMatchObject({
      mediaId: "media-1",
      thumbnailStatus: "ready",
      thumbnailUri: "test-media://1/1",
    });

    runtime.dispose();
  });

  it("keeps Canvas on the derived representation pipeline", async () => {
    const scan = new FakeScanPort();
    const derived = new TrackingDerivedRepresentationPort();
    const runtime = createViewerRuntime(
      {
        scan,
        sourcePicker: new SingleSourcePicker(),
        representation: derived,
        resource: new ResourcePort(),
        detail: new NullDetailPort(),
      },
      { sessionIdFactory: () => "session-1" },
    );
    const canvas = runtime.createCanvasBrowser();
    canvas.setViewport({ width: 800, height: 600, devicePixelRatio: 1 });

    await runtime.workspace.pickAndOpenSource();
    scan.emit({ event: "started", data: { sessionId: "session-1" } });
    scan.emit({
      event: "batch",
      data: { sessionId: "session-1", items: [media()] },
    });
    await flushMicrotasks();

    expect(derived.calls.length).toBeGreaterThan(0);

    canvas.dispose();
    runtime.dispose();
  });
});
