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
  resolve: (value: ThumbnailRepresentation) => void;
}

class LeaseTrackingPort implements MediaRepresentationPort {
  readonly calls: PendingCall[] = [];
  readonly releases: string[] = [];

  requestThumbnail(request: ThumbnailRequest): Promise<ThumbnailRepresentation> {
    return new Promise((resolve) => {
      this.calls.push({ request: { ...request }, resolve });
    });
  }

  async releaseRepresentation(resourceKey: string): Promise<void> {
    this.releases.push(resourceKey);
  }

  resolve(index: number, resourceKey = `derived-${index}`): void {
    const call = this.calls[index];
    call.resolve({
      resourceKey,
      width: call.request.maxEdge,
      height: call.request.maxEdge,
    });
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("representation leases", () => {
  it("releases one backend registration only after every shared subscriber lease is released", async () => {
    const port = new LeaseTrackingPort();
    const scheduler = new RepresentationScheduler(port);

    const firstPromise = scheduler.requestThumbnail({
      resourceKey: "source",
      maxEdge: 256,
      priority: "visible",
    });
    const secondPromise = scheduler.requestThumbnail({
      resourceKey: "source",
      maxEdge: 256,
      priority: "overscan",
    });
    await flushMicrotasks();

    expect(port.calls).toHaveLength(1);
    port.resolve(0, "derived-shared");
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    first.release();
    first.release();
    await flushMicrotasks();
    expect(port.releases).toEqual([]);

    second.release();
    await flushMicrotasks();
    expect(port.releases).toEqual(["derived-shared"]);
  });

  it("releases a running orphan immediately when the backend eventually completes", async () => {
    const port = new LeaseTrackingPort();
    const scheduler = new RepresentationScheduler(port, { maxConcurrent: 1 });
    const abortController = new AbortController();

    const request = scheduler.requestThumbnail({
      resourceKey: "source",
      maxEdge: 256,
      priority: "visible",
      signal: abortController.signal,
    });
    const cancelled = expect(request).rejects.toBeInstanceOf(
      RepresentationRequestCancelledError,
    );
    await flushMicrotasks();
    expect(port.calls).toHaveLength(1);

    abortController.abort();
    await cancelled;
    port.resolve(0, "derived-orphan");
    await flushMicrotasks();

    expect(port.releases).toEqual(["derived-orphan"]);
  });

  it("does not rejoin orphaned running work when the backend ignores cancellation", async () => {
    const port = new LeaseTrackingPort();
    const scheduler = new RepresentationScheduler(port, { maxConcurrent: 1 });
    const abortController = new AbortController();

    const orphaned = scheduler.requestThumbnail({
      resourceKey: "source",
      maxEdge: 512,
      priority: "visible",
      signal: abortController.signal,
    });
    const cancelled = expect(orphaned).rejects.toBeInstanceOf(
      RepresentationRequestCancelledError,
    );
    await flushMicrotasks();
    abortController.abort();
    await cancelled;

    const replacement = scheduler.requestThumbnail({
      resourceKey: "source",
      maxEdge: 512,
      priority: "visible",
    });
    await flushMicrotasks();
    expect(port.calls).toHaveLength(1);

    // This fake port intentionally ignores the backend AbortSignal. The old
    // work therefore occupies its concurrency slot until it completes, but its
    // result is orphaned and must not be handed to the replacement consumer.
    port.resolve(0, "derived-orphan");
    await flushMicrotasks();
    expect(port.releases).toEqual(["derived-orphan"]);
    expect(port.calls).toHaveLength(2);

    port.resolve(1, "derived-replacement");
    const lease = await replacement;
    expect(port.releases).toEqual(["derived-orphan"]);

    lease.release();
    await flushMicrotasks();
    expect(port.releases).toEqual(["derived-orphan", "derived-replacement"]);
  });

  it("releases once per backend job even when later jobs resolve to the same derived key", async () => {
    const port = new LeaseTrackingPort();
    const scheduler = new RepresentationScheduler(port);

    const firstPromise = scheduler.requestThumbnail({
      resourceKey: "source",
      maxEdge: 128,
      priority: "visible",
    });
    await flushMicrotasks();
    port.resolve(0, "derived-stable");
    const first = await firstPromise;
    first.release();
    await flushMicrotasks();

    const secondPromise = scheduler.requestThumbnail({
      resourceKey: "source",
      maxEdge: 128,
      priority: "visible",
    });
    await flushMicrotasks();
    port.resolve(1, "derived-stable");
    const second = await secondPromise;
    second.release();
    await flushMicrotasks();

    expect(port.releases).toEqual(["derived-stable", "derived-stable"]);
  });
});
