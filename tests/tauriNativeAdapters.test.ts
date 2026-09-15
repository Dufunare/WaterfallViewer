import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage: ((event: unknown) => void) | null }>,
  invoke: vi.fn(),
  convertFileSrc: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel {
    onmessage: ((event: unknown) => void) | null = null;

    constructor() {
      tauriMocks.channels.push(this);
    }
  },
  invoke: tauriMocks.invoke,
  convertFileSrc: tauriMocks.convertFileSrc,
}));

import type { MediaScanEvent } from "../src/application/ports/mediaScan";
import { TauriMediaResourcePort } from "../src/platform/tauri/mediaResource";
import { scanMedia } from "../src/platform/tauri/mediaScan";

beforeEach(() => {
  tauriMocks.channels.length = 0;
  tauriMocks.invoke.mockReset();
  tauriMocks.convertFileSrc.mockReset();
});

describe("Tauri native adapters", () => {
  it("keeps scanMedia pending until the terminal channel event arrives", async () => {
    tauriMocks.invoke.mockResolvedValue(undefined);
    const events: MediaScanEvent[] = [];

    let settled = false;
    const scan = scanMedia(
      {
        sessionId: "session-1",
        source: { id: "source-1", locator: "opaque-source" },
        batchSize: 64,
      },
      (event) => events.push(event),
    ).then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(tauriMocks.channels).toHaveLength(1);

    const channel = tauriMocks.channels[0];
    channel.onmessage?.({ event: "started", data: { sessionId: "session-1" } });
    expect(settled).toBe(false);

    channel.onmessage?.({
      event: "finished",
      data: {
        sessionId: "session-1",
        summary: { discoveredFiles: 1, acceptedMedia: 1, emittedBatches: 1 },
      },
    });

    await scan;
    expect(settled).toBe(true);
    expect(events.map((event) => event.event)).toEqual(["started", "finished"]);
  });

  it("keeps opaque resource-key slashes as URL path separators", () => {
    tauriMocks.convertFileSrc.mockImplementation(
      (path: string, protocol: string) =>
        `http://${protocol}.localhost/${encodeURIComponent(path)}`,
    );

    const port = new TauriMediaResourcePort();

    expect(port.uriFor("3/8")).toBe("http://waterfall-media.localhost/3/8");
    expect(tauriMocks.convertFileSrc).toHaveBeenCalledWith("", "waterfall-media");
  });
});
