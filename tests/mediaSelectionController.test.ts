import { describe, expect, it } from "vitest";

import { MediaSessionController } from "../src/application/mediaSession";
import type {
  MediaItem,
  MediaScanEvent,
  MediaScanPort,
  MediaScanRequest,
} from "../src/application/ports/mediaScan";
import { MediaSelectionController } from "../src/application/selection/mediaSelectionController";

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

function media(id: string, kind: MediaItem["kind"] = "image"): MediaItem {
  return {
    id,
    sourceId: "source-1",
    name: `${id}.jpg`,
    relativePath: `${id}.jpg`,
    kind,
    fileSize: 100,
    modifiedAtMs: null,
    visual: kind === "audio" ? null : { width: 100, height: 100 },
    resourceKey: `1/${id}`,
  };
}

function openSession(
  sessions: MediaSessionController,
  scanPort: FakeScanPort,
  sessionId: string,
  scanIndex: number,
  items: readonly MediaItem[],
): void {
  sessions.openSource({ id: `source-${scanIndex}`, locator: `local/${scanIndex}` });
  scanPort.emit(scanIndex, { event: "started", data: { sessionId } });
  scanPort.emit(scanIndex, {
    event: "batch",
    data: { sessionId, items },
  });
}

describe("MediaSelectionController", () => {
  it("starts empty and replaces selection idempotently", () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const selection = new MediaSelectionController(sessions);

    expect(selection.snapshot).toEqual({
      sessionId: null,
      selectedIds: [],
      primaryId: null,
    });

    openSession(sessions, scanPort, "session-1", 0, [media("a"), media("b")]);
    expect(selection.replace("a")).toBe(true);
    expect(selection.replace("a")).toBe(false);
    expect(selection.snapshot).toEqual({
      sessionId: "session-1",
      selectedIds: ["a"],
      primaryId: "a",
    });

    selection.dispose();
  });

  it("toggles additive selection and moves the primary item", () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const selection = new MediaSelectionController(sessions);
    openSession(sessions, scanPort, "session-1", 0, [media("a"), media("b")]);

    expect(selection.toggle("a")).toBe(true);
    expect(selection.toggle("b")).toBe(true);
    expect(selection.snapshot).toEqual({
      sessionId: "session-1",
      selectedIds: ["a", "b"],
      primaryId: "b",
    });

    expect(selection.toggle("b")).toBe(true);
    expect(selection.snapshot).toEqual({
      sessionId: "session-1",
      selectedIds: ["a"],
      primaryId: "a",
    });

    expect(selection.toggle("a")).toBe(true);
    expect(selection.snapshot).toEqual({
      sessionId: "session-1",
      selectedIds: [],
      primaryId: null,
    });

    selection.dispose();
  });

  it("survives filter changes within the same session", () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const selection = new MediaSelectionController(sessions);
    openSession(sessions, scanPort, "session-1", 0, [media("image"), media("audio", "audio")]);

    selection.replace("image");
    sessions.setIncludedKinds(["audio"]);

    expect(selection.snapshot).toEqual({
      sessionId: "session-1",
      selectedIds: ["image"],
      primaryId: "image",
    });

    selection.dispose();
  });

  it("clears selection when the source session is replaced", () => {
    const scanPort = new FakeScanPort();
    const ids = ["session-1", "session-2"];
    const sessions = new MediaSessionController(scanPort, () => ids.shift()!);
    const selection = new MediaSelectionController(sessions);

    openSession(sessions, scanPort, "session-1", 0, [media("a")]);
    selection.replace("a");
    openSession(sessions, scanPort, "session-2", 1, [media("b")]);

    expect(selection.snapshot).toEqual({
      sessionId: "session-2",
      selectedIds: [],
      primaryId: null,
    });

    selection.dispose();
  });

  it("rejects missing media and publishes only actual changes", () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, () => "session-1");
    const selection = new MediaSelectionController(sessions);
    const snapshots: string[][] = [];
    const unsubscribe = selection.subscribe((snapshot) => {
      snapshots.push([...snapshot.selectedIds]);
    });

    openSession(sessions, scanPort, "session-1", 0, [media("a")]);
    expect(selection.replace("missing")).toBe(false);
    expect(selection.replace(" ")).toBe(false);
    expect(selection.clear()).toBe(false);
    expect(selection.replace("a")).toBe(true);
    expect(selection.clear()).toBe(true);

    expect(snapshots).toEqual([[], [], ["a"], []]);
    unsubscribe();
    selection.dispose();
  });
});
