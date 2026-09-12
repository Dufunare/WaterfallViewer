import { describe, expect, it } from "vitest";

import {
  MediaSessionController,
  type SessionIdFactory,
} from "../src/application/mediaSession";
import type {
  MediaItem,
  MediaScanEvent,
  MediaScanPort,
  MediaScanRequest,
} from "../src/application/ports/mediaScan";

interface PendingScan {
  request: MediaScanRequest;
  onEvent: (event: MediaScanEvent) => void;
  resolve: () => void;
  reject: (error: unknown) => void;
}

class FakeMediaScanPort implements MediaScanPort {
  readonly scans: PendingScan[] = [];
  readonly cancelRequests: string[] = [];
  cancelResult = true;

  scan(
    request: MediaScanRequest,
    onEvent: (event: MediaScanEvent) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.scans.push({ request, onEvent, resolve, reject });
    });
  }

  async cancel(sessionId: string): Promise<boolean> {
    this.cancelRequests.push(sessionId);
    return this.cancelResult;
  }

  emit(index: number, event: MediaScanEvent): void {
    this.scans[index].onEvent(event);
  }

  resolveScan(index: number): void {
    this.scans[index].resolve();
  }

  rejectScan(index: number, error: unknown): void {
    this.scans[index].reject(error);
  }
}

function ids(...values: string[]): SessionIdFactory {
  const queue = [...values];
  return () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("test session id queue exhausted");
    }
    return next;
  };
}

function mediaItem(id: string, name = `${id}.jpg`): MediaItem {
  return {
    id,
    sourceId: "source-1",
    name,
    relativePath: name,
    kind: "image",
    fileSize: 42,
    modifiedAtMs: null,
    visual: { width: 100, height: 80 },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MediaSessionController", () => {
  it("builds an incremental index and preserves order when items are updated", () => {
    const port = new FakeMediaScanPort();
    const controller = new MediaSessionController(port, ids("session-1"));

    controller.openSource({ id: "source-1", locator: "/media" }, 2);
    port.emit(0, { event: "started", data: { sessionId: "session-1" } });
    port.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [mediaItem("a"), mediaItem("b")],
      },
    });
    port.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [mediaItem("a", "a-updated.jpg")],
      },
    });
    port.emit(0, {
      event: "warning",
      data: {
        sessionId: "session-1",
        warning: { path: null, message: "recoverable problem" },
      },
    });

    expect(controller.current?.scanState.status).toBe("scanning");
    expect(controller.current?.items.size).toBe(2);
    expect(controller.current?.items.ids()).toEqual(["a", "b"]);
    expect(controller.current?.items.get("a")?.name).toBe("a-updated.jpg");
    expect(controller.current?.scanState.receivedItems).toBe(2);
    expect(controller.current?.scanState.warningCount).toBe(1);

    const summary = {
      discoveredFiles: 3,
      acceptedMedia: 2,
      emittedBatches: 2,
    };
    port.emit(0, {
      event: "finished",
      data: { sessionId: "session-1", summary },
    });
    port.resolveScan(0);

    expect(controller.current?.scanState.status).toBe("finished");
    expect(controller.current?.scanState.summary).toEqual(summary);
  });

  it("ignores stale events after the active source is replaced", () => {
    const port = new FakeMediaScanPort();
    const controller = new MediaSessionController(
      port,
      ids("session-1", "session-2"),
    );

    controller.openSource({ id: "source-1", locator: "/first" });
    controller.openSource({ id: "source-2", locator: "/second" });

    expect(port.cancelRequests).toEqual(["session-1"]);
    expect(controller.current?.id).toBe("session-2");

    port.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [mediaItem("stale")] },
    });
    port.emit(0, {
      event: "finished",
      data: {
        sessionId: "session-1",
        summary: { discoveredFiles: 1, acceptedMedia: 1, emittedBatches: 1 },
      },
    });

    expect(controller.current?.items.size).toBe(0);
    expect(controller.current?.scanState.status).toBe("starting");

    port.emit(1, { event: "started", data: { sessionId: "session-2" } });
    port.emit(1, {
      event: "batch",
      data: { sessionId: "session-2", items: [mediaItem("fresh")] },
    });

    expect(controller.current?.items.ids()).toEqual(["fresh"]);
    expect(controller.current?.scanState.status).toBe("scanning");
  });

  it("moves through cancelling to cancelled without dropping late batches", async () => {
    const port = new FakeMediaScanPort();
    const controller = new MediaSessionController(port, ids("session-1"));

    controller.openSource({ id: "source-1", locator: "/media" });
    port.emit(0, { event: "started", data: { sessionId: "session-1" } });

    await expect(controller.cancelCurrent()).resolves.toBe(true);
    expect(controller.current?.scanState.status).toBe("cancelling");

    port.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [mediaItem("last-item")] },
    });
    expect(controller.current?.items.ids()).toEqual(["last-item"]);

    const summary = {
      discoveredFiles: 1,
      acceptedMedia: 1,
      emittedBatches: 1,
    };
    port.emit(0, {
      event: "cancelled",
      data: { sessionId: "session-1", summary },
    });
    port.resolveScan(0);

    expect(controller.current?.scanState.status).toBe("cancelled");
    expect(controller.current?.scanState.summary).toEqual(summary);
  });

  it("records scan failures only for the current session", async () => {
    const port = new FakeMediaScanPort();
    const controller = new MediaSessionController(
      port,
      ids("session-1", "session-2"),
    );

    controller.openSource({ id: "source-1", locator: "/first" });
    controller.openSource({ id: "source-2", locator: "/second" });

    port.rejectScan(0, { code: "source-unavailable", message: "old failed" });
    await flushMicrotasks();
    expect(controller.current?.id).toBe("session-2");
    expect(controller.current?.scanState.status).toBe("starting");

    port.rejectScan(1, { code: "source-unavailable", message: "missing folder" });
    await flushMicrotasks();

    expect(controller.current?.scanState.status).toBe("failed");
    expect(controller.current?.scanState.error).toEqual({
      code: "source-unavailable",
      message: "missing folder",
    });
  });

  it("treats a scan that resolves without a terminal event as a protocol failure", async () => {
    const port = new FakeMediaScanPort();
    const controller = new MediaSessionController(port, ids("session-1"));

    controller.openSource({ id: "source-1", locator: "/media" });
    port.emit(0, { event: "started", data: { sessionId: "session-1" } });
    port.resolveScan(0);
    await flushMicrotasks();

    expect(controller.current?.scanState.status).toBe("failed");
    expect(controller.current?.scanState.error?.code).toBe("protocol-error");
  });

  it("rejects invalid batch sizes before invoking the scan port", () => {
    const port = new FakeMediaScanPort();
    const controller = new MediaSessionController(port, ids("session-1"));

    expect(() =>
      controller.openSource({ id: "source-1", locator: "/media" }, 0),
    ).toThrow("batchSize must be a positive integer");
    expect(port.scans).toHaveLength(0);
  });
});
