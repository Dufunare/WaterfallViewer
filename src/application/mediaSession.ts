import type {
  MediaItem,
  MediaScanEvent,
  MediaScanPort,
  ScanSummary,
  ScanWarning,
  SourceDescriptor,
} from "./ports/mediaScan";

export type ScanStatus =
  | "starting"
  | "scanning"
  | "cancelling"
  | "finished"
  | "cancelled"
  | "failed";

export interface SessionError {
  code: string | null;
  message: string;
}

export interface ScanState {
  status: ScanStatus;
  receivedItems: number;
  warningCount: number;
  summary: ScanSummary | null;
  error: SessionError | null;
}

export class MediaIndex {
  readonly #byId = new Map<string, MediaItem>();
  readonly #order: string[] = [];
  #replacementRevision = 0;

  get size(): number {
    return this.#byId.size;
  }

  get replacementRevision(): number {
    return this.#replacementRevision;
  }

  get(id: string): MediaItem | undefined {
    return this.#byId.get(id);
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  ids(): readonly string[] {
    return [...this.#order];
  }

  values(): readonly MediaItem[] {
    return this.#order.map((id) => this.#byId.get(id)!);
  }

  valuesFrom(startIndex: number): readonly MediaItem[] {
    if (
      !Number.isInteger(startIndex) ||
      startIndex < 0 ||
      startIndex > this.#order.length
    ) {
      throw new RangeError("startIndex must be an integer within the media index");
    }
    return this.#order
      .slice(startIndex)
      .map((id) => this.#byId.get(id)!);
  }

  upsertMany(items: readonly MediaItem[]): void {
    for (const item of items) {
      if (!this.#byId.has(item.id)) {
        this.#order.push(item.id);
      } else {
        this.#replacementRevision += 1;
      }
      this.#byId.set(item.id, item);
    }
  }
}

export interface MediaSession {
  readonly id: string;
  readonly source: SourceDescriptor;
  readonly scanState: ScanState;
  readonly items: MediaIndex;
  readonly warnings: readonly ScanWarning[];
}

export type MediaSessionListener = (session: MediaSession | null) => void;
export type SessionIdFactory = () => string;

export class MediaSessionController {
  readonly #scanPort: MediaScanPort;
  readonly #sessionIdFactory: SessionIdFactory;
  readonly #listeners = new Set<MediaSessionListener>();

  #current: MediaSession | null = null;

  constructor(
    scanPort: MediaScanPort,
    sessionIdFactory: SessionIdFactory = defaultSessionIdFactory,
  ) {
    this.#scanPort = scanPort;
    this.#sessionIdFactory = sessionIdFactory;
  }

  get current(): MediaSession | null {
    return this.#current;
  }

  subscribe(listener: MediaSessionListener): () => void {
    this.#listeners.add(listener);
    listener(this.#current);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  openSource(source: SourceDescriptor, batchSize = 64): string {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError("batchSize must be a positive integer");
    }

    const sessionId = this.#sessionIdFactory();
    if (sessionId.trim().length === 0) {
      throw new Error("session id factory returned an empty id");
    }

    const previous = this.#current;
    if (previous !== null && isActive(previous.scanState.status)) {
      void this.#scanPort.cancel(previous.id).catch(() => undefined);
    }

    this.#current = {
      id: sessionId,
      source: { ...source },
      scanState: {
        status: "starting",
        receivedItems: 0,
        warningCount: 0,
        summary: null,
        error: null,
      },
      items: new MediaIndex(),
      warnings: [],
    };
    this.#publish();

    void this.#runScan(sessionId, { ...source }, batchSize);
    return sessionId;
  }

  async cancelCurrent(): Promise<boolean> {
    const target = this.#current;
    if (target === null || !isActive(target.scanState.status)) {
      return false;
    }

    const accepted = await this.#scanPort.cancel(target.id);
    if (!accepted) {
      return false;
    }

    const current = this.#current;
    if (
      current !== null &&
      current.id === target.id &&
      isActive(current.scanState.status)
    ) {
      this.#replaceCurrent({
        ...current,
        scanState: {
          ...current.scanState,
          status: "cancelling",
        },
      });
    }

    return true;
  }

  async #runScan(
    sessionId: string,
    source: SourceDescriptor,
    batchSize: number,
  ): Promise<void> {
    try {
      await this.#scanPort.scan(
        { sessionId, source, batchSize },
        (event) => this.#handleEvent(event),
      );
    } catch (error) {
      this.#failIfCurrent(sessionId, normalizeSessionError(error));
      return;
    }

    const current = this.#current;
    if (
      current !== null &&
      current.id === sessionId &&
      isActive(current.scanState.status)
    ) {
      this.#failIfCurrent(sessionId, {
        code: "protocol-error",
        message: "scan completed without a terminal event",
      });
    }
  }

  #handleEvent(event: MediaScanEvent): void {
    const current = this.#current;
    const sessionId = event.data.sessionId;
    if (current === null || current.id !== sessionId) {
      if (event.event === "started") {
        void this.#scanPort.cancel(sessionId).catch(() => undefined);
      }
      return;
    }

    if (isTerminal(current.scanState.status)) {
      return;
    }

    switch (event.event) {
      case "started":
        if (current.scanState.status === "starting") {
          this.#replaceCurrent({
            ...current,
            scanState: {
              ...current.scanState,
              status: "scanning",
            },
          });
        }
        break;

      case "batch":
        current.items.upsertMany(event.data.items);
        this.#replaceCurrent({
          ...current,
          scanState: {
            ...current.scanState,
            receivedItems: current.items.size,
          },
        });
        break;

      case "warning": {
        const warnings = [...current.warnings, event.data.warning];
        this.#replaceCurrent({
          ...current,
          warnings,
          scanState: {
            ...current.scanState,
            warningCount: warnings.length,
          },
        });
        break;
      }

      case "finished":
        this.#replaceCurrent({
          ...current,
          scanState: {
            ...current.scanState,
            status: "finished",
            summary: event.data.summary,
            error: null,
          },
        });
        break;

      case "cancelled":
        this.#replaceCurrent({
          ...current,
          scanState: {
            ...current.scanState,
            status: "cancelled",
            summary: event.data.summary,
            error: null,
          },
        });
        break;
    }
  }

  #failIfCurrent(sessionId: string, error: SessionError): void {
    const current = this.#current;
    if (
      current === null ||
      current.id !== sessionId ||
      isTerminal(current.scanState.status)
    ) {
      return;
    }

    this.#replaceCurrent({
      ...current,
      scanState: {
        ...current.scanState,
        status: "failed",
        error,
      },
    });
  }

  #replaceCurrent(session: MediaSession): void {
    this.#current = session;
    this.#publish();
  }

  #publish(): void {
    for (const listener of [...this.#listeners]) {
      listener(this.#current);
    }
  }
}

function isActive(status: ScanStatus): boolean {
  return status === "starting" || status === "scanning" || status === "cancelling";
}

function isTerminal(status: ScanStatus): boolean {
  return status === "finished" || status === "cancelled" || status === "failed";
}

function normalizeSessionError(error: unknown): SessionError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };
    const code = typeof candidate.code === "string" ? candidate.code : null;
    if (typeof candidate.message === "string") {
      return { code, message: candidate.message };
    }
  }

  if (error instanceof Error) {
    return { code: null, message: error.message };
  }

  return { code: null, message: String(error) };
}

function defaultSessionIdFactory(): string {
  return globalThis.crypto.randomUUID();
}
