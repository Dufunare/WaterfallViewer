import { describe, expect, it } from "vitest";

import type {
  MediaRepresentationPort,
  ThumbnailRepresentation,
  ThumbnailRequest,
} from "../src/application/ports/mediaRepresentation";
import { RepresentationScheduler } from "../src/application/resources/representationScheduler";

class ControlledPort implements MediaRepresentationPort {
  readonly calls: ThumbnailRequest[] = [];
  readonly resolvers: Array<(value: ThumbnailRepresentation) => void> = [];

  requestThumbnail(request: ThumbnailRequest): Promise<ThumbnailRepresentation> {
    this.calls.push({ ...request });
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  resolve(index: number): void {
    const request = this.calls[index];
    this.resolvers[index]({
      resourceKey: `derived-${request.resourceKey}-${request.maxEdge}`,
      width: request.maxEdge,
      height: request.maxEdge,
    });
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("RepresentationScheduler explicit promotion", () => {
  it("promotes queued work without creating another subscriber or backend request", async () => {
    const port = new ControlledPort();
    const scheduler = new RepresentationScheduler(port, { maxConcurrent: 1 });

    const blocker = scheduler.requestThumbnail({
      resourceKey: "blocker",
      maxEdge: 256,
      priority: "visible",
    });
    const shared = scheduler.requestThumbnail({
      resourceKey: "shared",
      maxEdge: 256,
      priority: "prefetch",
    });
    const other = scheduler.requestThumbnail({
      resourceKey: "other",
      maxEdge: 256,
      priority: "overscan",
    });
    await flushMicrotasks();

    expect(port.calls.map((call) => call.resourceKey)).toEqual(["blocker"]);
    expect(
      scheduler.promoteThumbnail(
        { resourceKey: "shared", maxEdge: 256 },
        "visible",
      ),
    ).toBe(true);

    port.resolve(0);
    await blocker;
    await flushMicrotasks();

    expect(port.calls.map((call) => call.resourceKey)).toEqual([
      "blocker",
      "shared",
    ]);

    port.resolve(1);
    await shared;
    await flushMicrotasks();
    expect(port.calls[2].resourceKey).toBe("other");

    port.resolve(2);
    await other;
    expect(port.calls.filter((call) => call.resourceKey === "shared")).toHaveLength(1);
  });

  it("does not restart already running work when promoted", async () => {
    const port = new ControlledPort();
    const scheduler = new RepresentationScheduler(port, { maxConcurrent: 1 });

    const request = scheduler.requestThumbnail({
      resourceKey: "shared",
      maxEdge: 512,
      priority: "prefetch",
    });
    await flushMicrotasks();
    expect(port.calls).toHaveLength(1);

    expect(
      scheduler.promoteThumbnail(
        { resourceKey: "shared", maxEdge: 512 },
        "visible",
      ),
    ).toBe(true);
    await flushMicrotasks();
    expect(port.calls).toHaveLength(1);

    port.resolve(0);
    await request;
  });

  it("limits background work so visible requests keep reserved capacity", async () => {
    const port = new ControlledPort();
    const scheduler = new RepresentationScheduler(port, {
      maxConcurrent: 3,
      maxBackgroundConcurrent: 1,
    });

    const firstBackground = scheduler.requestThumbnail({
      resourceKey: "background-1",
      maxEdge: 256,
      priority: "prefetch",
    });
    const secondBackground = scheduler.requestThumbnail({
      resourceKey: "background-2",
      maxEdge: 256,
      priority: "overscan",
    });
    const visibleA = scheduler.requestThumbnail({
      resourceKey: "visible-a",
      maxEdge: 256,
      priority: "visible",
    });
    const visibleB = scheduler.requestThumbnail({
      resourceKey: "visible-b",
      maxEdge: 256,
      priority: "visible",
    });
    await flushMicrotasks();

    expect(port.calls.map((call) => call.resourceKey)).toEqual([
      "background-1",
      "visible-a",
      "visible-b",
    ]);
    expect(port.calls.some((call) => call.resourceKey === "background-2")).toBe(false);

    port.resolve(1);
    port.resolve(2);
    await Promise.all([visibleA, visibleB]);
    await flushMicrotasks();
    expect(port.calls.some((call) => call.resourceKey === "background-2")).toBe(false);

    port.resolve(0);
    await firstBackground;
    await flushMicrotasks();
    expect(port.calls[3].resourceKey).toBe("background-2");
    port.resolve(3);
    await secondBackground;
  });
});
