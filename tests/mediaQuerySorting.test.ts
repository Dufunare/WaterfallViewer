import { describe, expect, it } from "vitest";

import { MediaIndex, MediaSessionController } from "../src/application/mediaSession";
import type { MediaResourcePort } from "../src/application/ports/mediaResource";
import type {
  MediaItem,
  MediaScanEvent,
  MediaScanPort,
  MediaScanRequest,
} from "../src/application/ports/mediaScan";
import { MediaQueryController } from "../src/application/query/mediaQueryController";
import { MediaActivationController } from "../src/application/viewer/mediaActivationController";

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

  emit(index: number, event: MediaScanEvent): void {
    this.listeners[index](event);
  }
}

class FakeResourcePort implements MediaResourcePort {
  uriFor(resourceKey: string): string {
    return `test-media://${resourceKey}`;
  }
}

function media(
  id: string,
  options: {
    kind?: MediaItem["kind"];
    name?: string;
    fileSize?: number;
    modifiedAtMs?: number | null;
  } = {},
): MediaItem {
  return {
    id,
    sourceId: "source-1",
    name: options.name ?? id,
    relativePath: id,
    kind: options.kind ?? "image",
    fileSize: options.fileSize ?? 1,
    modifiedAtMs: options.modifiedAtMs ?? null,
    visual: null,
    resourceKey: `resource/${id}`,
  };
}

function finish(scanPort: FakeScanPort, listenerIndex: number, sessionId: string, count: number): void {
  scanPort.emit(listenerIndex, {
    event: "finished",
    data: {
      sessionId,
      summary: {
        discoveredFiles: count,
        acceptedMedia: count,
        emittedBatches: 1,
      },
    },
  });
}

describe("media query sorting", () => {
  it("defers sorting until the scan is terminal and keeps the active media stable", () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const query = new MediaQueryController(sessions);
    const activation = new MediaActivationController(sessions, new FakeResourcePort());

    query.setSort("name-asc");
    sessions.openSource({ id: "source-1", locator: "source/1" });
    scanPort.emit(0, { event: "started", data: { sessionId: "session-1" } });
    scanPort.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [
          media("c", { name: "Charlie" }),
          media("a", { name: "Alpha" }),
          media("b", { name: "Bravo" }),
        ],
      },
    });

    expect(query.snapshot).toMatchObject({
      sort: "name-asc",
      effectiveSort: "source",
      sortPending: true,
    });
    expect(sessions.current?.items.ids()).toEqual(["c", "a", "b"]);
    expect(activation.activate("c")).toBe(true);
    expect(activation.snapshot).toMatchObject({ position: 1, totalItems: 3 });

    finish(scanPort, 0, "session-1", 3);

    expect(query.snapshot).toMatchObject({
      sort: "name-asc",
      effectiveSort: "name-asc",
      sortPending: false,
    });
    expect(sessions.current?.items.ids()).toEqual(["a", "b", "c"]);
    expect(activation.snapshot).toMatchObject({
      mediaId: "c",
      position: 3,
      totalItems: 3,
      hasPrevious: true,
      hasNext: false,
    });

    activation.dispose();
    query.dispose();
  });

  it("applies sort changes immediately after scanning and composes them with filtering", () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const query = new MediaQueryController(sessions);

    sessions.openSource({ id: "source-1", locator: "source/1" });
    scanPort.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [
          media("video", { kind: "video", fileSize: 500 }),
          media("small", { fileSize: 10 }),
          media("large", { fileSize: 1000 }),
          media("animated", { kind: "animated-image", fileSize: 200 }),
        ],
      },
    });
    finish(scanPort, 0, "session-1", 4);

    query.setIncludedKinds(["image", "animated-image"]);
    query.setSort("size-desc");

    expect(query.snapshot).toMatchObject({
      matchedItemCount: 3,
      sort: "size-desc",
      effectiveSort: "size-desc",
      sortPending: false,
    });
    expect(sessions.current?.items.ids()).toEqual(["large", "animated", "small"]);

    query.setSort("size-asc");
    expect(sessions.current?.items.ids()).toEqual(["small", "animated", "large"]);

    query.dispose();
  });

  it("preserves the requested sort across sources while deferring each active scan", () => {
    const scanPort = new FakeScanPort();
    const ids = ["session-1", "session-2"];
    const sessions = new MediaSessionController(scanPort, () => ids.shift()!);
    const query = new MediaQueryController(sessions);
    query.setSort("modified-desc");

    sessions.openSource({ id: "source-1", locator: "source/1" });
    scanPort.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [
          media("old-1", { modifiedAtMs: 10 }),
          media("new-1", { modifiedAtMs: 20 }),
        ],
      },
    });
    finish(scanPort, 0, "session-1", 2);
    expect(sessions.current?.items.ids()).toEqual(["new-1", "old-1"]);

    sessions.openSource({ id: "source-2", locator: "source/2" });
    scanPort.emit(1, {
      event: "batch",
      data: {
        sessionId: "session-2",
        items: [
          media("old-2", { modifiedAtMs: 30 }),
          media("new-2", { modifiedAtMs: 40 }),
        ],
      },
    });

    expect(query.snapshot).toMatchObject({
      sort: "modified-desc",
      effectiveSort: "source",
      sortPending: true,
    });
    expect(sessions.current?.items.ids()).toEqual(["old-2", "new-2"]);

    finish(scanPort, 1, "session-2", 2);
    expect(sessions.current?.items.ids()).toEqual(["new-2", "old-2"]);
    expect(query.snapshot.sortPending).toBe(false);

    query.dispose();
  });

  it("sorts a 50k projection deterministically without changing source cardinality", () => {
    const index = new MediaIndex();
    index.upsertMany(
      Array.from({ length: 50_000 }, (_, position) =>
        media(`media-${position}`, {
          kind: position % 2 === 0 ? "image" : "video",
          fileSize: position,
        }),
      ),
    );

    index.setIncludedKinds(["video"]);
    index.setSort("size-desc");

    expect(index.sourceSize).toBe(50_000);
    expect(index.size).toBe(25_000);
    expect(index.at(0)?.id).toBe("media-49999");
    expect(index.at(24_999)?.id).toBe("media-1");
    expect(index.indexOf("media-49999")).toBe(0);
    expect(index.indexOf("media-0")).toBe(-1);
  });
});
