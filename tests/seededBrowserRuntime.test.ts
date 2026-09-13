import { describe, expect, it } from "vitest";

import { createSeededBrowserRuntime } from "../src/testing/seededBrowserRuntime";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("seeded browser runtime", () => {
  it("drives the real runtime graph with deterministic seeded media", async () => {
    const runtime = createSeededBrowserRuntime();

    await expect(runtime.workspace.pickAndOpenSource()).resolves.toBe(true);
    await flushMicrotasks();

    expect(runtime.workspace.snapshot).toMatchObject({
      sourceDisplayName: "Seeded Browser Gallery",
      sessionId: "seeded-session-1",
      itemCount: 6,
    });
    expect(runtime.workspace.snapshot.scanState?.status).toBe("finished");
    expect(runtime.query.snapshot).toMatchObject({
      sourceItemCount: 6,
      matchedItemCount: 6,
    });

    runtime.query.setIncludedKinds(["video"]);
    expect(runtime.query.snapshot.matchedItemCount).toBe(1);

    runtime.query.setIncludedKinds(["audio"]);
    expect(runtime.query.snapshot.matchedItemCount).toBe(1);

    runtime.query.reset();
    expect(runtime.query.snapshot.matchedItemCount).toBe(6);

    expect(runtime.activation.activate("seed-video-1")).toBe(true);
    await flushMicrotasks();
    expect(runtime.previewDetails.snapshot).toEqual({
      mediaId: "seed-video-1",
      status: "ready",
      detail: {
        kind: "video",
        durationMs: 92_000,
        codec: "H.264",
      },
      error: null,
    });

    expect(runtime.activation.activate("seed-audio-1")).toBe(true);
    await flushMicrotasks();
    expect(runtime.previewDetails.snapshot).toEqual({
      mediaId: "seed-audio-1",
      status: "ready",
      detail: {
        kind: "audio",
        durationMs: 214_000,
        title: "Rainfall",
        artist: "WaterfallViewer Fixture",
        codec: "FLAC",
      },
      error: null,
    });

    runtime.dispose();
    runtime.dispose();
  });
});
