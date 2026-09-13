import { describe, expect, it } from "vitest";

import type {
  MediaDetail,
  MediaDetailPort,
  MediaDetailRequest,
} from "../src/application/ports/mediaDetail";
import type {
  ActiveMediaSnapshot,
  MediaActivationListener,
} from "../src/application/viewer/mediaActivationController";
import {
  PreviewMediaDetailController,
  type MediaActivationSource,
} from "../src/application/viewer/previewMediaDetailController";

interface PendingDetailCall {
  request: MediaDetailRequest;
  resolve: (detail: MediaDetail | null) => void;
  reject: (error: unknown) => void;
}

class ControlledDetailPort implements MediaDetailPort {
  readonly calls: PendingDetailCall[] = [];

  getDetail(request: MediaDetailRequest): Promise<MediaDetail | null> {
    return new Promise((resolve, reject) => {
      this.calls.push({ request: { ...request }, resolve, reject });
    });
  }
}

class FakeActivationSource implements MediaActivationSource {
  #snapshot: ActiveMediaSnapshot | null = null;
  readonly #listeners = new Set<MediaActivationListener>();

  get snapshot(): ActiveMediaSnapshot | null {
    return this.#snapshot === null ? null : { ...this.#snapshot };
  }

  subscribe(listener: MediaActivationListener): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  set(snapshot: ActiveMediaSnapshot | null): void {
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) {
      listener(this.snapshot);
    }
  }
}

function active(
  mediaId: string,
  kind: ActiveMediaSnapshot["kind"],
): ActiveMediaSnapshot {
  return {
    sessionId: "session-1",
    mediaId,
    name: `${mediaId}.media`,
    relativePath: `${mediaId}.media`,
    kind,
    resourceKey: `1/${mediaId}`,
    uri: `test-media://1/${mediaId}`,
    position: 1,
    totalItems: 1,
    hasPrevious: false,
    hasNext: false,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("PreviewMediaDetailController", () => {
  it("loads video detail only after a multimedia item becomes active", async () => {
    const activation = new FakeActivationSource();
    const port = new ControlledDetailPort();
    const controller = new PreviewMediaDetailController(activation, port);

    expect(controller.snapshot).toEqual({
      mediaId: null,
      status: "idle",
      detail: null,
      error: null,
    });

    activation.set(active("clip", "video"));
    expect(controller.snapshot).toMatchObject({ mediaId: "clip", status: "loading" });
    expect(port.calls[0].request).toEqual({ resourceKey: "1/clip", kind: "video" });

    port.calls[0].resolve({ kind: "video", durationMs: 12_345, codec: "avc1" });
    await flushMicrotasks();
    expect(controller.snapshot).toEqual({
      mediaId: "clip",
      status: "ready",
      detail: { kind: "video", durationMs: 12_345, codec: "avc1" },
      error: null,
    });

    controller.dispose();
  });

  it("does not request rich details for images", () => {
    const activation = new FakeActivationSource();
    const port = new ControlledDetailPort();
    const controller = new PreviewMediaDetailController(activation, port);

    activation.set(active("photo", "image"));
    expect(port.calls).toHaveLength(0);
    expect(controller.snapshot.status).toBe("idle");

    activation.set(active("animation", "animated-image"));
    expect(port.calls).toHaveLength(0);
    expect(controller.snapshot.status).toBe("idle");

    controller.dispose();
  });

  it("ignores detail results from an item that is no longer active", async () => {
    const activation = new FakeActivationSource();
    const port = new ControlledDetailPort();
    const controller = new PreviewMediaDetailController(activation, port);

    activation.set(active("first", "video"));
    activation.set(active("second", "audio"));
    expect(port.calls).toHaveLength(2);

    port.calls[0].resolve({ kind: "video", durationMs: 1000, codec: "old" });
    await flushMicrotasks();
    expect(controller.snapshot).toMatchObject({ mediaId: "second", status: "loading" });

    port.calls[1].resolve({
      kind: "audio",
      durationMs: 2000,
      title: "Current",
      artist: "Artist",
      codec: "mp3",
    });
    await flushMicrotasks();
    expect(controller.snapshot).toMatchObject({
      mediaId: "second",
      status: "ready",
      detail: { kind: "audio", title: "Current" },
    });

    controller.dispose();
  });

  it("treats metadata failures as non-fatal preview state", async () => {
    const activation = new FakeActivationSource();
    const port = new ControlledDetailPort();
    const controller = new PreviewMediaDetailController(activation, port);

    activation.set(active("clip", "video"));
    port.calls[0].reject(new Error("metadata unavailable"));
    await flushMicrotasks();

    expect(controller.snapshot).toEqual({
      mediaId: "clip",
      status: "error",
      detail: null,
      error: "metadata unavailable",
    });

    activation.set(null);
    expect(controller.snapshot.status).toBe("idle");
    controller.dispose();
  });

  it("invalidates in-flight work on disposal", async () => {
    const activation = new FakeActivationSource();
    const port = new ControlledDetailPort();
    const controller = new PreviewMediaDetailController(activation, port);

    activation.set(active("clip", "video"));
    controller.dispose();
    port.calls[0].resolve({ kind: "video", durationMs: 1000, codec: "avc1" });
    await flushMicrotasks();

    expect(controller.snapshot.status).toBe("idle");
    expect(() => controller.subscribe(() => undefined)).toThrow(/disposed/);
  });
});
