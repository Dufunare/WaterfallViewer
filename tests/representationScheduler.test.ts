import { describe, expect, it } from "vitest";

import type {
  MediaRepresentationPort,
  ThumbnailRepresentation,
  ThumbnailRequest,
} from "../src/application/ports/mediaRepresentation";
import {
  RepresentationRequestCancelledError,
  RepresentationScheduler,
} from "../src/application/resources/representationScheduler";

interface PendingCall {
  request: ThumbnailRequest;
  signal?: AbortSignal;
  resolve: (value: ThumbnailRepresentation) => void;
  reject: (error: unknown) => void;
}

class FakeRepresentationPort implements MediaRepresentationPort {
  readonly calls: PendingCall[] = [];
  active = 0;
  maxActive = 0;

  requestThumbnail(
    request: ThumbnailRequest,
    signal?: AbortSignal,
  ): Promise<ThumbnailRepresentation> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);

    return new Promise<ThumbnailRepresentation>((resolve, reject) => {
      let settled = false;
      const finishResolve = (value: ThumbnailRepresentation) => {
        if (settled) {
          return;
        }
        settled = true;
        this.active -= 1;
        resolve(value);
      };
      const finishReject = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        this.active -= 1;
        reject(error);
      };
      const call: PendingCall = {
        request: { ...request },
        signal,
        resolve: finishResolve,
        reject: finishReject,
      };
      this.calls.push(call);

      if (signal?.aborted) {
        finishReject(new Error("backend request cancelled"));
      } else {
        signal?.addEventListener(
          "abort",
          () => finishReject(new Error("backend request cancelled")),
          { once: true },
        );
      }
    });
  }

  resolve(index: number): ThumbnailRepresentation {
    const call = this.calls[index];
    const representation = thumbnail(
      `${call.request.resourceKey}-thumb`,
      call.request.maxEdge,
    );
    call.resolve(representation);
    return representation;
  }

  reject(index: number, error: unknown): void {
    this.calls[index].reject(error);
  }
}

function thumbnail(resourceKey: string, maxEdge: number): ThumbnailRepresentation {
  return {
    resourceKey,
    width: maxEdge,
    height: Math.max(1, Math.floor(maxEdge / 2)),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("RepresentationScheduler", () => {
  it("never exceeds the configured concurrency limit", async () => {
    const port = new FakeRepresentationPort();
    const scheduler = new RepresentationScheduler(port, { maxConcurrent: 2 });

    const requests = ["a", "b", "c", "d"].map((resourceKey) =>
      scheduler.requestThumbnail({ resourceKey, maxEdge: 256, priority: "visible" }),
    );
    await flushMicrotasks();

    expect(port.calls).toHaveLength(2);
    expect(port.maxActive).toBe(2);

    port.resolve(0);
    await flushMicrotasks();
    expect(port.calls).toHaveLength(3);
    expect(port.maxActive).toBe(2);

    port.resolve(1);
    await flushMicrotasks();
    expect(port.calls).toHaveLength(4);
    expect(port.maxActive).toBe(2);

    port.resolve(2);
    port.resolve(3);
    await Promise.all(requests);
    expect(port.active).toBe(0);
  });

  it("runs visible work before overscan and prefetch work", async () => {
    const port = new FakeRepresentationPort();
    const scheduler = new RepresentationScheduler(port, { maxConcurrent: 1 });

    const blocker = scheduler.requestThumbnail({
      resourceKey: "blocker",
      maxEdge: 256,
      priority: "visible",
    });
    const prefetch = scheduler.requestThumbnail({
      resourceKey: "prefetch",
      maxEdge: 256,
      priority: "prefetch",
    });
    const overscan = scheduler.requestThumbnail({
      resourceKey: "overscan",
      maxEdge: 256,
      priority: "overscan",
    });
    const visible = scheduler.requestThumbnail({
      resourceKey: "visible",
      maxEdge: 256,
      priority: "visible",
    });
    await flushMicrotasks();

    expect(port.calls.map((call) => call.request.resourceKey)).toEqual(["blocker"]);

    port.resolve(0);
    await flushMicrotasks();
    expect(port.calls[1].request.resourceKey).toBe("visible");

    port.resolve(1);
    await flushMicrotasks();
    expect(port.calls[2].request.resourceKey).toBe("overscan");

    port.resolve(2);
    await flushMicrotasks();
    expect(port.calls[3].request.resourceKey).toBe("prefetch");

    port.resolve(3);
    await Promise.all([blocker, prefetch, overscan, visible]);
  });

  it("deduplicates identical thumbnail requests", async () => {
    const port = new FakeRepresentationPort();
    const scheduler = new RepresentationScheduler(port);

    const first = scheduler.requestThumbnail({
      resourceKey: "shared",
      maxEdge: 320,
      priority: "visible",
    });
    const second = scheduler.requestThumbnail({
      resourceKey: "shared",
      maxEdge: 320,
      priority: "overscan",
    });
    await flushMicrotasks();

    expect(port.calls).toHaveLength(1);
    const expected = port.resolve(0);
    await expect(first).resolves.toMatchObject(expected);
    await expect(second).resolves.toMatchObject(expected);
  });

  it("promotes queued duplicate work when a higher-priority subscriber arrives", async () => {
    const port = new FakeRepresentationPort();
    const scheduler = new RepresentationScheduler(port, { maxConcurrent: 1 });

    const blocker = scheduler.requestThumbnail({
      resourceKey: "blocker",
      maxEdge: 256,
      priority: "visible",
    });
    const firstShared = scheduler.requestThumbnail({
      resourceKey: "shared",
      maxEdge: 256,
      priority: "prefetch",
    });
    const unrelated = scheduler.requestThumbnail({
      resourceKey: "other",
      maxEdge: 256,
      priority: "overscan",
    });
    const promotedShared = scheduler.requestThumbnail({
      resourceKey: "shared",
      maxEdge: 256,
      priority: "visible",
    });
    await flushMicrotasks();

    port.resolve(0);
    await flushMicrotasks();
    expect(port.calls[1].request.resourceKey).toBe("shared");

    const sharedRepresentation = port.resolve(1);
    await expect(firstShared).resolves.toMatchObject(sharedRepresentation);
    await expect(promotedShared).resolves.toMatchObject(sharedRepresentation);
    await flushMicrotasks();
    expect(port.calls[2].request.resourceKey).toBe("other");

    port.resolve(2);
    await Promise.all([blocker, unrelated]);
  });

  it("drops queued work when all subscribers cancel", async () => {
    const port = new FakeRepresentationPort();
    const scheduler = new RepresentationScheduler(port, { maxConcurrent: 1 });
    const controller = new AbortController();

    const blocker = scheduler.requestThumbnail({
      resourceKey: "blocker",
      maxEdge: 256,
      priority: "visible",
    });
    const cancelled = scheduler.requestThumbnail({
      resourceKey: "cancelled",
      maxEdge: 256,
      priority: "prefetch",
      signal: controller.signal,
    });
    const cancellation = expect(cancelled).rejects.toBeInstanceOf(
      RepresentationRequestCancelledError,
    );
    await flushMicrotasks();

    controller.abort();
    await cancellation;
    port.resolve(0);
    await blocker;
    await flushMicrotasks();

    expect(port.calls.map((call) => call.request.resourceKey)).toEqual(["blocker"]);
  });

  it("cancels one subscriber without cancelling shared work", async () => {
    const port = new FakeRepresentationPort();
    const scheduler = new RepresentationScheduler(port);
    const controller = new AbortController();

    const cancelled = scheduler.requestThumbnail({
      resourceKey: "shared",
      maxEdge: 256,
      priority: "visible",
      signal: controller.signal,
    });
    const retained = scheduler.requestThumbnail({
      resourceKey: "shared",
      maxEdge: 256,
      priority: "visible",
    });
    const cancellation = expect(cancelled).rejects.toBeInstanceOf(
      RepresentationRequestCancelledError,
    );
    await flushMicrotasks();

    controller.abort();
    await cancellation;
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].signal?.aborted).toBe(false);

    const expected = port.resolve(0);
    await expect(retained).resolves.toMatchObject(expected);
  });

  it("aborts orphaned running work and starts a fresh request for later consumers", async () => {
    const port = new FakeRepresentationPort();
    const scheduler = new RepresentationScheduler(port, { maxConcurrent: 1 });
    const controller = new AbortController();

    const orphaned = scheduler.requestThumbnail({
      resourceKey: "shared",
      maxEdge: 256,
      priority: "visible",
      signal: controller.signal,
    });
    const cancellation = expect(orphaned).rejects.toBeInstanceOf(
      RepresentationRequestCancelledError,
    );
    await flushMicrotasks();
    expect(port.calls).toHaveLength(1);

    controller.abort();
    await cancellation;
    expect(port.calls[0].signal?.aborted).toBe(true);
    await flushMicrotasks();

    const replacement = scheduler.requestThumbnail({
      resourceKey: "shared",
      maxEdge: 256,
      priority: "visible",
    });
    await flushMicrotasks();
    expect(port.calls).toHaveLength(2);
    expect(port.calls[1].signal?.aborted).toBe(false);

    const expected = port.resolve(1);
    await expect(replacement).resolves.toMatchObject(expected);
  });

  it("propagates failures and frees capacity for queued work", async () => {
    const port = new FakeRepresentationPort();
    const scheduler = new RepresentationScheduler(port, { maxConcurrent: 1 });

    const failed = scheduler.requestThumbnail({
      resourceKey: "failed",
      maxEdge: 256,
      priority: "visible",
    });
    const next = scheduler.requestThumbnail({
      resourceKey: "next",
      maxEdge: 256,
      priority: "visible",
    });
    const failure = expect(failed).rejects.toThrow("decode failed");
    await flushMicrotasks();

    port.reject(0, new Error("decode failed"));
    await failure;
    await flushMicrotasks();
    expect(port.calls[1].request.resourceKey).toBe("next");

    const expected = port.resolve(1);
    await expect(next).resolves.toMatchObject(expected);
  });

  it("rejects invalid scheduler and request configuration", async () => {
    const port = new FakeRepresentationPort();
    expect(() => new RepresentationScheduler(port, { maxConcurrent: 0 })).toThrow(
      RangeError,
    );

    const scheduler = new RepresentationScheduler(port);
    expect(() =>
      scheduler.requestThumbnail({
        resourceKey: " ",
        maxEdge: 256,
        priority: "visible",
      }),
    ).toThrow(RangeError);
    expect(() =>
      scheduler.requestThumbnail({
        resourceKey: "image",
        maxEdge: 0,
        priority: "visible",
      }),
    ).toThrow(RangeError);

    const controller = new AbortController();
    controller.abort();
    await expect(
      scheduler.requestThumbnail({
        resourceKey: "image",
        maxEdge: 256,
        priority: "visible",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RepresentationRequestCancelledError);
    expect(port.calls).toHaveLength(0);
  });
});
