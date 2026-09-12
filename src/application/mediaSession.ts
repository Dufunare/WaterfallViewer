import type {
  MediaItem,
  MediaKind,
  MediaScanEvent,
  MediaScanPort,
  ScanSummary,
  ScanWarning,
  SourceDescriptor,
} from "./ports/mediaScan";

export const ALL_MEDIA_KINDS: readonly MediaKind[] = [
  "image",
  "animated-image",
  "video",
  "audio",
];

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
  readonly #sourceOrder: string[] = [];
  readonly #order: string[] = [];
  readonly #orderIndexById = new Map<string, number>();
  #includedKinds: Set<MediaKind>;
  #replacementRevision = 0;
  #projectionRevision = 0;

  constructor(includedKinds: readonly MediaKind[] = ALL_MEDIA_KINDS) {
    this.#includedKinds = normalizeKinds(includedKinds);
  }

  /** Number of items in the current query projection. */
  get size(): number {
    return this.#order.length;
  }

  /** Number of source media items discovered regardless of the query. */
  get sourceSize(): number {
    return this.#byId.size;
  }

  /**
   * Full-resync revision consumed by layout/view controllers. It advances for
   * item replacement and for structural query projection rebuilds.
   */
  get replacementRevision(): number {
    return this.#replacementRevision;
  }

  get projectionRevision(): number {
    return this.#projectionRevision;
  }

  get includedKinds(): readonly MediaKind[] {
    return ALL_MEDIA_KINDS.filter((kind) => this.#includedKinds.has(kind));
  }

  get(id: string): MediaItem | undefined {
    if (!this.#orderIndexById.has(id)) {
      return undefined;
    }
    return this.#byId.get(id);
  }

  has(id: string): boolean {
    return this.#orderIndexById.has(id);
  }

  at(index: number): MediaItem | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.#order.length) {
      return undefined;
    }
    const id = this.#order[index];
    return this.#byId.get(id);
  }

  indexOf(id: string): number {
    return this.#orderIndexById.get(id) ?? -1;
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

  setIncludedKinds(kinds: readonly MediaKind[]): boolean {
    const next = normalizeKinds(kinds);
    if (sameKindSet(this.#includedKinds, next)) {
      return false;
    }
    this.#includedKinds = next;
    this.#rebuildProjection();
    this.#projectionRevision += 1;
    this.#replacementRevision += 1;
    return true;
  }

  upsertMany(items: readonly MediaItem[]): void {
    let requiresProjectionRebuild = false;
    for (const item of items) {
      const existing = this.#byId.get(item.id);
      if (existing === undefined) {
        this.#sourceOrder.push(item.id);
        this.#byId.set(item.id, item);
        if (this.#includedKinds.has(item.kind)) {
          const index = this.#order.length;
          this.#order.push(item.id);
          this.#orderIndexById.set(item.id, index);
        }
        continue;
      }

      const wasIncluded = this.#includedKinds.has(existing.kind);
      const isIncluded = this.#includedKinds.has(item.kind);
      this.#byId.set(item.id, item);
      this.#replacementRevision += 1;
      if (wasIncluded !== isIncluded) {
        requiresProjectionRebuild = true;
      }
    }

    if (requiresProjectionRebuild) {
      this.#rebuildProjection();
      this.#projectionRevision += 1;
    }
  }

  #rebuildProjection(): void {
    this.#order.length = 0;
    this.#orderIndexById.clear();
    for (const id of this.#sourceOrder) {
      const item = this.#byId.get(id);
      if (item === undefined || !this.#includedKinds.has(item.kind)) {
        continue;
      }
      const index = this.#order.length;
      this.#order.push(id);
      this.#orderIndexById.set(id, index);
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
  #includedKinds: readonly MediaKind[] = ALL_MEDIA_KINDS;

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

  get includedKinds(): readonly MediaKind[] {
    return [...this.#includedKinds];
  }

  subscribe(listener: MediaSessionListener): () => void {
    this.#listeners.add(listener);
    listener(this.#current);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  setIncludedKinds(kinds: readonly MediaKind[]): boolean {
    const next = canonicalKinds(kinds);
    if (sameKindArray(this.#includedKinds, next)) {
      return false;
    }

    this.#includedKinds = next;
    const current = this.#current;
    if (current !== null && current.items.setIncludedKinds(next)) {
      this.#replaceCurrent({ ...current });
    }
    return true;
  }

  resetIncludedKinds(): boolean {
    return this.setIncludedKinds(ALL_MEDIA_KINDS);
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
      items: new MediaIndex(this.#includedKinds),
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
            receivedItems: current.items.sourceSize,
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

function normalizeKinds(kinds: readonly MediaKind[]): Set<MediaKind> {
  const next = new Set<MediaKind>();
  for (const kind of kinds) {
    if (!ALL_MEDIA_KINDS.includes(kind)) {
      throw new RangeError(`unsupported media kind: ${String(kind)}`);
    }
    next.add(kind);
  }
  return next;
}

function canonicalKinds(kinds: readonly MediaKind[]): readonly MediaKind[] {
  const set = normalizeKinds(kinds);
  return ALL_MEDIA_KINDS.filter((kind) => set.has(kind));
}

function sameKindSet(left: ReadonlySet<MediaKind>, right: ReadonlySet<MediaKind>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const kind of left) {
    if (!right.has(kind)) {
      return false;
    }
  }
  return true;
}

function sameKindArray(left: readonly MediaKind[], right: readonly MediaKind[]): boolean {
  return left.length === right.length && left.every((kind, index) => kind === right[index]);
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
