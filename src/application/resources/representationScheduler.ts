import type {
  MediaRepresentationPort,
  ThumbnailRepresentation,
  ThumbnailRequest,
} from "../ports/mediaRepresentation";

export type RepresentationPriority = "visible" | "overscan" | "prefetch";

export interface ScheduledThumbnailRequest extends ThumbnailRequest {
  priority: RepresentationPriority;
  signal?: AbortSignal;
}

export interface ThumbnailRepresentationLease extends ThumbnailRepresentation {
  /** Idempotently release this consumer's ownership of the representation. */
  release(): void;
}

export interface RepresentationSchedulerOptions {
  maxConcurrent?: number;
}

export class RepresentationRequestCancelledError extends Error {
  constructor() {
    super("representation request was cancelled");
    this.name = "RepresentationRequestCancelledError";
  }
}

type JobState = "queued" | "running";

interface Subscriber {
  resolve: (representation: ThumbnailRepresentationLease) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface PendingJob {
  key: string;
  request: ThumbnailRequest;
  priority: RepresentationPriority;
  sequence: number;
  revision: number;
  state: JobState;
  subscribers: Map<number, Subscriber>;
}

interface QueueEntry {
  job: PendingJob;
  revision: number;
  rank: number;
  sequence: number;
}

const DEFAULT_MAX_CONCURRENT = 6;

export class RepresentationScheduler {
  private readonly maxConcurrent: number;
  private readonly jobs = new Map<string, PendingJob>();
  private readonly queue: QueueEntry[] = [];
  private runningCount = 0;
  private nextJobSequence = 0;
  private nextSubscriberId = 0;

  constructor(
    private readonly port: MediaRepresentationPort,
    options: RepresentationSchedulerOptions = {},
  ) {
    const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new RangeError("maxConcurrent must be a positive integer");
    }
    this.maxConcurrent = maxConcurrent;
  }

  requestThumbnail(
    request: ScheduledThumbnailRequest,
  ): Promise<ThumbnailRepresentationLease> {
    this.validateRequest(request);
    if (request.signal?.aborted) {
      return Promise.reject(new RepresentationRequestCancelledError());
    }

    const key = thumbnailRequestKey(request);
    let job = this.jobs.get(key);
    if (job === undefined) {
      job = {
        key,
        request: {
          resourceKey: request.resourceKey,
          maxEdge: request.maxEdge,
        },
        priority: request.priority,
        sequence: this.nextJobSequence++,
        revision: 0,
        state: "queued",
        subscribers: new Map(),
      };
      this.jobs.set(key, job);
      this.pushQueueEntry(job);
    } else if (
      job.state === "queued" &&
      priorityRank(request.priority) > priorityRank(job.priority)
    ) {
      job.priority = request.priority;
      job.revision += 1;
      this.pushQueueEntry(job);
    }

    const activeJob = job;
    const promise = new Promise<ThumbnailRepresentationLease>((resolve, reject) => {
      const subscriberId = this.nextSubscriberId++;
      const subscriber: Subscriber = {
        resolve,
        reject,
        signal: request.signal,
      };

      if (request.signal !== undefined) {
        const abortListener = () => {
          this.cancelSubscriber(activeJob, subscriberId);
        };
        subscriber.abortListener = abortListener;
        request.signal.addEventListener("abort", abortListener, { once: true });
      }

      activeJob.subscribers.set(subscriberId, subscriber);
    });

    this.pump();
    return promise;
  }

  private validateRequest(request: ScheduledThumbnailRequest): void {
    if (request.resourceKey.trim().length === 0) {
      throw new RangeError("resourceKey must not be empty");
    }
    if (!Number.isInteger(request.maxEdge) || request.maxEdge <= 0) {
      throw new RangeError("maxEdge must be a positive integer");
    }
    priorityRank(request.priority);
  }

  private cancelSubscriber(job: PendingJob, subscriberId: number): void {
    const subscriber = job.subscribers.get(subscriberId);
    if (subscriber === undefined) {
      return;
    }

    this.removeAbortListener(subscriber);
    job.subscribers.delete(subscriberId);
    subscriber.reject(new RepresentationRequestCancelledError());

    if (job.subscribers.size === 0 && job.state === "queued") {
      job.revision += 1;
      if (this.jobs.get(job.key) === job) {
        this.jobs.delete(job.key);
      }
    }

    this.pump();
  }

  private pump(): void {
    while (this.runningCount < this.maxConcurrent) {
      const job = this.popNextJob();
      if (job === undefined) {
        return;
      }

      job.state = "running";
      this.runningCount += 1;
      void this.run(job);
    }
  }

  private async run(job: PendingJob): Promise<void> {
    try {
      const representation = await Promise.resolve().then(() =>
        this.port.requestThumbnail(job.request),
      );
      const subscribers = this.takeSubscribers(job);
      if (subscribers.length === 0) {
        this.releaseBackendRegistration(representation.resourceKey);
      } else {
        const group = new RepresentationLeaseGroup(
          this.port,
          representation.resourceKey,
        );
        for (const subscriber of subscribers) {
          subscriber.resolve(group.createLease(representation));
        }
      }
    } catch (error) {
      for (const subscriber of this.takeSubscribers(job)) {
        subscriber.reject(error);
      }
    } finally {
      this.runningCount -= 1;
      if (this.jobs.get(job.key) === job) {
        this.jobs.delete(job.key);
      }
      this.pump();
    }
  }

  private takeSubscribers(job: PendingJob): Subscriber[] {
    const subscribers = [...job.subscribers.values()];
    for (const subscriber of subscribers) {
      this.removeAbortListener(subscriber);
    }
    job.subscribers.clear();
    return subscribers;
  }

  private releaseBackendRegistration(resourceKey: string): void {
    if (this.port.releaseRepresentation === undefined) {
      return;
    }
    void this.port.releaseRepresentation(resourceKey).catch(() => undefined);
  }

  private removeAbortListener(subscriber: Subscriber): void {
    if (subscriber.signal !== undefined && subscriber.abortListener !== undefined) {
      subscriber.signal.removeEventListener("abort", subscriber.abortListener);
    }
  }

  private pushQueueEntry(job: PendingJob): void {
    const entry: QueueEntry = {
      job,
      revision: job.revision,
      rank: priorityRank(job.priority),
      sequence: job.sequence,
    };
    this.queue.push(entry);
    this.siftUp(this.queue.length - 1);
  }

  private popNextJob(): PendingJob | undefined {
    while (this.queue.length > 0) {
      const entry = this.popHeapRoot();
      const { job } = entry;
      if (
        entry.revision !== job.revision ||
        job.state !== "queued" ||
        job.subscribers.size === 0 ||
        this.jobs.get(job.key) !== job
      ) {
        continue;
      }
      return job;
    }
    return undefined;
  }

  private popHeapRoot(): QueueEntry {
    const root = this.queue[0];
    const tail = this.queue.pop();
    if (tail !== undefined && this.queue.length > 0) {
      this.queue[0] = tail;
      this.siftDown(0);
    }
    return root;
  }

  private siftUp(startIndex: number): void {
    let index = startIndex;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!comesBefore(this.queue[index], this.queue[parent])) {
        break;
      }
      [this.queue[index], this.queue[parent]] = [
        this.queue[parent],
        this.queue[index],
      ];
      index = parent;
    }
  }

  private siftDown(startIndex: number): void {
    let index = startIndex;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;

      if (
        left < this.queue.length &&
        comesBefore(this.queue[left], this.queue[best])
      ) {
        best = left;
      }
      if (
        right < this.queue.length &&
        comesBefore(this.queue[right], this.queue[best])
      ) {
        best = right;
      }
      if (best === index) {
        return;
      }

      [this.queue[index], this.queue[best]] = [
        this.queue[best],
        this.queue[index],
      ];
      index = best;
    }
  }
}

class RepresentationLeaseGroup {
  private remaining = 0;
  private backendReleased = false;

  constructor(
    private readonly port: MediaRepresentationPort,
    private readonly resourceKey: string,
  ) {}

  createLease(
    representation: ThumbnailRepresentation,
  ): ThumbnailRepresentationLease {
    this.remaining += 1;
    return new ScheduledThumbnailLease(representation, () => {
      this.releaseOne();
    });
  }

  private releaseOne(): void {
    if (this.remaining <= 0) {
      return;
    }
    this.remaining -= 1;
    if (this.remaining === 0) {
      this.releaseBackend();
    }
  }

  private releaseBackend(): void {
    if (this.backendReleased) {
      return;
    }
    this.backendReleased = true;
    if (this.port.releaseRepresentation === undefined) {
      return;
    }
    void this.port.releaseRepresentation(this.resourceKey).catch(() => undefined);
  }
}

class ScheduledThumbnailLease implements ThumbnailRepresentationLease {
  readonly resourceKey: string;
  readonly width: number;
  readonly height: number;
  private released = false;

  constructor(
    representation: ThumbnailRepresentation,
    private readonly onRelease: () => void,
  ) {
    this.resourceKey = representation.resourceKey;
    this.width = representation.width;
    this.height = representation.height;
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.onRelease();
  }
}

function thumbnailRequestKey(request: ThumbnailRequest): string {
  return JSON.stringify([request.resourceKey, request.maxEdge]);
}

function priorityRank(priority: RepresentationPriority): number {
  switch (priority) {
    case "visible":
      return 3;
    case "overscan":
      return 2;
    case "prefetch":
      return 1;
    default:
      throw new RangeError(`unknown representation priority: ${String(priority)}`);
  }
}

function comesBefore(left: QueueEntry, right: QueueEntry): boolean {
  if (left.rank !== right.rank) {
    return left.rank > right.rank;
  }
  return left.sequence < right.sequence;
}
