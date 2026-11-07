import { describe, expect, it } from "vitest";

import {
  LegacyFlowBrowserController,
  type LegacyFlowBrowserEvent,
} from "../src/application/browser/legacyFlowBrowserController";
import { MediaSessionController } from "../src/application/mediaSession";
import type { MediaResourcePort } from "../src/application/ports/mediaResource";
import type {
  MediaItem,
  MediaScanEvent,
  MediaScanPort,
  MediaScanRequest,
} from "../src/application/ports/mediaScan";

class ControlledScanPort implements MediaScanPort {
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

class FakeResourcePort implements MediaResourcePort {
  readonly resolved: string[] = [];

  uriFor(resourceKey: string): string {
    this.resolved.push(resourceKey);
    return `http://127.0.0.1:1234/token/${resourceKey}`;
  }
}

function media(index: number, kind: MediaItem["kind"] = "image"): MediaItem {
  return {
    id: `media-${index}`,
    sourceId: "source-1",
    name: `media-${index}.jpg`,
    relativePath: `media-${index}.jpg`,
    kind,
    fileSize: 100 + index,
    modifiedAtMs: index,
    visual: null,
    resourceKey: `1/${index + 1}`,
  };
}

function batch(items: readonly MediaItem[]): MediaScanEvent {
  return {
    event: "batch",
    data: { sessionId: "session-1", items: [...items] },
  };
}

describe("LegacyFlowBrowserController incremental contract", () => {
  it("emits only newly discovered images on ordinary scan growth", () => {
    const scan = new ControlledScanPort();
    const session = new MediaSessionController(scan, () => "session-1");
    const resources = new FakeResourcePort();
    const browser = new LegacyFlowBrowserController(session, resources);
    const events: LegacyFlowBrowserEvent[] = [];
    browser.subscribe((event) => events.push(event));

    session.openSource({ id: "source-1", locator: "local-source/1" }, 64);
    scan.emit({ event: "started", data: { sessionId: "session-1" } });
    scan.emit(batch([media(0), media(1)]));
    scan.emit(batch([media(2), media(3, "video")]));

    const appends = events.filter(
      (event): event is Extract<LegacyFlowBrowserEvent, { type: "append" }> =>
        event.type === "append",
    );
    expect(appends.map((event) => event.items.map((item) => item.mediaId))).toEqual([
      ["media-0", "media-1"],
      ["media-2"],
    ]);
    expect(resources.resolved).toEqual(["1/1", "1/2", "1/3"]);
    expect(browser.snapshot.itemCount).toBe(4);
    expect(browser.snapshot.renderableItemCount).toBe(3);

    browser.dispose();
  });

  it("uses reset for structural projection changes and reuses the current session", () => {
    const scan = new ControlledScanPort();
    const session = new MediaSessionController(scan, () => "session-1");
    const browser = new LegacyFlowBrowserController(session, new FakeResourcePort());
    const events: LegacyFlowBrowserEvent[] = [];
    browser.subscribe((event) => events.push(event));

    session.openSource({ id: "source-1", locator: "local-source/1" }, 64);
    scan.emit({ event: "started", data: { sessionId: "session-1" } });
    scan.emit(batch([media(0), media(1), media(2, "video")]));

    const generationBefore = browser.snapshot.generation;
    session.setIncludedKinds(["image", "animated-image"]);

    const latest = events.at(-1)!;
    expect(latest.type).toBe("reset");
    if (latest.type === "reset") {
      expect(latest.items.map((item) => item.mediaId)).toEqual([
        "media-0",
        "media-1",
      ]);
    }
    expect(browser.snapshot.sessionId).toBe("session-1");
    expect(browser.snapshot.generation).toBeGreaterThan(generationBefore);

    browser.dispose();
  });
});
