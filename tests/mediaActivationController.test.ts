import { describe, expect, it } from "vitest";

import { MediaSessionController } from "../src/application/mediaSession";
import type { MediaResourcePort } from "../src/application/ports/mediaResource";
import type {
  MediaItem,
  MediaScanEvent,
  MediaScanPort,
  MediaScanRequest,
} from "../src/application/ports/mediaScan";
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
  readonly resolvedKeys: string[] = [];

  uriFor(resourceKey: string): string {
    this.resolvedKeys.push(resourceKey);
    return `test-media://${resourceKey}`;
  }
}

function media(id: string, kind: MediaItem["kind"] = "video"): MediaItem {
  return {
    id,
    sourceId: "source-1",
    name: `${id}.mp4`,
    relativePath: `nested/${id}.mp4`,
    kind,
    fileSize: 100,
    modifiedAtMs: null,
    visual: null,
    resourceKey: `1/${id}`,
  };
}

describe("MediaActivationController", () => {
  it("resolves an original resource URI only when media is explicitly activated", () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const resources = new FakeResourcePort();
    const activation = new MediaActivationController(sessions, resources);

    sessions.openSource({ id: "source-1", locator: "local-source/1" });
    scanPort.emit(0, { event: "started", data: { sessionId: "session-1" } });
    scanPort.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [media("clip")] },
    });

    expect(activation.snapshot).toBeNull();
    expect(resources.resolvedKeys).toEqual([]);
    expect(activation.activate("clip")).toBe(true);
    expect(resources.resolvedKeys).toEqual(["1/clip"]);
    expect(activation.snapshot).toEqual({
      sessionId: "session-1",
      mediaId: "clip",
      name: "clip.mp4",
      relativePath: "nested/clip.mp4",
      kind: "video",
      uri: "test-media://1/clip",
      position: 1,
      totalItems: 1,
      hasPrevious: false,
      hasNext: false,
    });

    activation.dispose();
  });

  it("navigates adjacent media in stable scan order and stops at the edges", () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const activation = new MediaActivationController(sessions, new FakeResourcePort());

    sessions.openSource({ id: "source-1", locator: "local-source/1" });
    scanPort.emit(0, {
      event: "batch",
      data: {
        sessionId: "session-1",
        items: [media("first", "image"), media("second"), media("third", "audio")],
      },
    });

    expect(activation.activate("second")).toBe(true);
    expect(activation.snapshot).toMatchObject({
      mediaId: "second",
      position: 2,
      totalItems: 3,
      hasPrevious: true,
      hasNext: true,
    });

    expect(activation.activatePrevious()).toBe(true);
    expect(activation.snapshot).toMatchObject({
      mediaId: "first",
      position: 1,
      hasPrevious: false,
      hasNext: true,
    });
    expect(activation.activatePrevious()).toBe(false);
    expect(activation.snapshot?.mediaId).toBe("first");

    expect(activation.activateNext()).toBe(true);
    expect(activation.snapshot?.mediaId).toBe("second");
    expect(activation.activateNext()).toBe(true);
    expect(activation.snapshot).toMatchObject({
      mediaId: "third",
      position: 3,
      hasPrevious: true,
      hasNext: false,
    });
    expect(activation.activateNext()).toBe(false);
    expect(activation.snapshot?.mediaId).toBe("third");

    activation.dispose();
  });

  it("makes newly streamed media navigable without moving the current item", () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const activation = new MediaActivationController(sessions, new FakeResourcePort());

    sessions.openSource({ id: "source-1", locator: "local-source/1" });
    scanPort.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [media("first")] },
    });
    activation.activate("first");
    expect(activation.snapshot).toMatchObject({
      mediaId: "first",
      position: 1,
      totalItems: 1,
      hasNext: false,
    });

    scanPort.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [media("second")] },
    });
    expect(activation.snapshot).toMatchObject({
      mediaId: "first",
      position: 1,
      totalItems: 2,
      hasNext: true,
    });
    expect(activation.activateNext()).toBe(true);
    expect(activation.snapshot).toMatchObject({
      mediaId: "second",
      position: 2,
      totalItems: 2,
      hasPrevious: true,
      hasNext: false,
    });

    activation.dispose();
  });

  it("returns false for media outside the current session", () => {
    const sessions = new MediaSessionController(new FakeScanPort(), () => "session-1");
    const activation = new MediaActivationController(sessions, new FakeResourcePort());

    expect(activation.activate("missing")).toBe(false);
    expect(activation.activatePrevious()).toBe(false);
    expect(activation.activateNext()).toBe(false);
    expect(activation.snapshot).toBeNull();
    activation.dispose();
  });

  it("clears stale activation when the source session is replaced", () => {
    const scanPort = new FakeScanPort();
    const ids = ["session-1", "session-2"];
    const sessions = new MediaSessionController(scanPort, () => ids.shift()!);
    const activation = new MediaActivationController(sessions, new FakeResourcePort());

    sessions.openSource({ id: "source-1", locator: "local-source/1" });
    scanPort.emit(0, { event: "started", data: { sessionId: "session-1" } });
    scanPort.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [media("clip")] },
    });
    activation.activate("clip");

    sessions.openSource({ id: "source-2", locator: "local-source/2" });
    expect(activation.snapshot).toBeNull();
    expect(activation.activateNext()).toBe(false);
    activation.dispose();
  });

  it("publishes activation and clear exactly as shared state", () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const activation = new MediaActivationController(sessions, new FakeResourcePort());
    const snapshots: Array<string | null> = [];
    const unsubscribe = activation.subscribe((snapshot) => {
      snapshots.push(snapshot?.mediaId ?? null);
    });

    sessions.openSource({ id: "source-1", locator: "local-source/1" });
    scanPort.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [media("clip")] },
    });
    activation.activate("clip");
    activation.clear();
    activation.clear();

    expect(snapshots).toEqual([null, "clip", null]);
    unsubscribe();
    activation.dispose();
  });

  it("rejects empty ids and use after disposal", () => {
    const sessions = new MediaSessionController(new FakeScanPort(), () => "session-1");
    const activation = new MediaActivationController(sessions, new FakeResourcePort());

    expect(() => activation.activate(" ")).toThrow(/mediaId/);
    activation.dispose();
    expect(() => activation.activate("clip")).toThrow(/disposed/);
    expect(() => activation.activatePrevious()).toThrow(/disposed/);
    expect(() => activation.activateNext()).toThrow(/disposed/);
  });
});
