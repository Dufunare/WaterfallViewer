import type {
  MediaDetail,
  MediaDetailPort,
  MediaDetailRequest,
} from "../application/ports/mediaDetail";
import type {
  MediaRepresentationPort,
  ThumbnailRepresentation,
  ThumbnailRequest,
} from "../application/ports/mediaRepresentation";
import type { MediaResourcePort } from "../application/ports/mediaResource";
import type {
  MediaItem,
  MediaScanEvent,
  MediaScanPort,
  MediaScanRequest,
} from "../application/ports/mediaScan";
import type {
  PickedSource,
  SourcePickerPort,
} from "../application/ports/sourcePicker";
import { createViewerRuntime, type ViewerRuntime } from "../bootstrap/viewerRuntime";

const SEEDED_SOURCE_ID = "seeded-browser-source";

const SEEDED_MEDIA: readonly MediaItem[] = [
  image("seed-image-1", "Aurora.jpg", 1200, 800, 1_700_000_001_000),
  image("seed-image-2", "Canyon.jpg", 900, 1200, 1_700_000_002_000),
  image("seed-image-3", "Forest.jpg", 1600, 900, 1_700_000_003_000),
  image("seed-image-4", "Harbor.jpg", 1000, 1000, 1_700_000_004_000),
  {
    id: "seed-video-1",
    sourceId: SEEDED_SOURCE_ID,
    name: "Orbit.mp4",
    relativePath: "video/Orbit.mp4",
    kind: "video",
    fileSize: 8_000_000,
    modifiedAtMs: 1_700_000_005_000,
    visual: { width: 1920, height: 1080 },
    resourceKey: "seed/5",
  },
  {
    id: "seed-audio-1",
    sourceId: SEEDED_SOURCE_ID,
    name: "Rainfall.flac",
    relativePath: "audio/Rainfall.flac",
    kind: "audio",
    fileSize: 5_000_000,
    modifiedAtMs: 1_700_000_006_000,
    visual: null,
    resourceKey: "seed/6",
  },
];

class SeededScanPort implements MediaScanPort {
  #cancelledSessionId: string | null = null;

  async scan(
    request: MediaScanRequest,
    onEvent: (event: MediaScanEvent) => void,
  ): Promise<void> {
    this.#cancelledSessionId = null;
    onEvent({ event: "started", data: { sessionId: request.sessionId } });
    await Promise.resolve();
    if (this.#emitCancelledIfNeeded(request.sessionId, onEvent)) {
      return;
    }

    const split = 3;
    onEvent({
      event: "batch",
      data: {
        sessionId: request.sessionId,
        items: SEEDED_MEDIA.slice(0, split).map(cloneMedia),
      },
    });
    await Promise.resolve();
    if (this.#emitCancelledIfNeeded(request.sessionId, onEvent)) {
      return;
    }

    onEvent({
      event: "batch",
      data: {
        sessionId: request.sessionId,
        items: SEEDED_MEDIA.slice(split).map(cloneMedia),
      },
    });
    onEvent({
      event: "finished",
      data: {
        sessionId: request.sessionId,
        summary: {
          discoveredFiles: SEEDED_MEDIA.length,
          acceptedMedia: SEEDED_MEDIA.length,
          emittedBatches: 2,
        },
      },
    });
  }

  async cancel(sessionId: string): Promise<boolean> {
    this.#cancelledSessionId = sessionId;
    return true;
  }

  #emitCancelledIfNeeded(
    sessionId: string,
    onEvent: (event: MediaScanEvent) => void,
  ): boolean {
    if (this.#cancelledSessionId !== sessionId) {
      return false;
    }
    onEvent({
      event: "cancelled",
      data: {
        sessionId,
        summary: {
          discoveredFiles: 0,
          acceptedMedia: 0,
          emittedBatches: 0,
        },
      },
    });
    return true;
  }
}

class SeededSourcePicker implements SourcePickerPort {
  async pickDirectory(): Promise<PickedSource> {
    return {
      source: {
        id: SEEDED_SOURCE_ID,
        locator: "seeded-browser://gallery",
      },
      displayName: "Seeded Browser Gallery",
    };
  }
}

class SeededRepresentationPort implements MediaRepresentationPort {
  async requestThumbnail(
    request: ThumbnailRequest,
    signal?: AbortSignal,
  ): Promise<ThumbnailRepresentation> {
    if (signal?.aborted) {
      throw new DOMException("Thumbnail request aborted", "AbortError");
    }
    return {
      resourceKey: `seed-thumb/${request.resourceKey}/${request.maxEdge}`,
      width: request.maxEdge,
      height: Math.max(1, Math.round(request.maxEdge * 0.75)),
    };
  }

  async releaseRepresentation(_resourceKey: string): Promise<void> {}
}

class SeededResourcePort implements MediaResourcePort {
  uriFor(resourceKey: string): string {
    return svgDataUri(resourceKey);
  }
}

class SeededDetailPort implements MediaDetailPort {
  async getDetail(request: MediaDetailRequest): Promise<MediaDetail | null> {
    if (request.kind === "video") {
      return {
        kind: "video",
        durationMs: 92_000,
        codec: "H.264",
      };
    }
    if (request.kind === "audio") {
      return {
        kind: "audio",
        durationMs: 214_000,
        title: "Rainfall",
        artist: "WaterfallViewer Fixture",
        codec: "FLAC",
      };
    }
    return null;
  }
}

export function createSeededBrowserRuntime(): ViewerRuntime {
  let sessionSequence = 0;
  return createViewerRuntime(
    {
      scan: new SeededScanPort(),
      sourcePicker: new SeededSourcePicker(),
      representation: new SeededRepresentationPort(),
      resource: new SeededResourcePort(),
      detail: new SeededDetailPort(),
    },
    {
      sessionIdFactory: () => `seeded-session-${++sessionSequence}`,
    },
  );
}

function image(
  id: string,
  name: string,
  width: number,
  height: number,
  modifiedAtMs: number,
): MediaItem {
  const index = Number(id.slice(-1));
  return {
    id,
    sourceId: SEEDED_SOURCE_ID,
    name,
    relativePath: `images/${name}`,
    kind: "image",
    fileSize: width * height,
    modifiedAtMs,
    visual: { width, height },
    resourceKey: `seed/${index}`,
  };
}

function cloneMedia(item: MediaItem): MediaItem {
  return {
    ...item,
    visual: item.visual === null ? null : { ...item.visual },
  };
}

function svgDataUri(label: string): string {
  const escaped = escapeXml(label.slice(0, 36));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><rect width="640" height="480" fill="#20242b"/><circle cx="320" cy="210" r="120" fill="#485261"/><text x="320" y="390" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#f3f4f6">${escaped}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
