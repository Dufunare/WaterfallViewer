import {
  MediaSessionController,
  type MediaSession,
  type ScanState,
} from "../mediaSession";
import type { SourcePickerPort } from "../ports/sourcePicker";

export interface ViewerWorkspaceOptions {
  scanBatchSize?: number;
}

export interface ViewerWorkspaceSnapshot {
  sourceDisplayName: string | null;
  sessionId: string | null;
  scanState: ScanState | null;
  itemCount: number;
}

export type ViewerWorkspaceListener = (snapshot: ViewerWorkspaceSnapshot) => void;

const DEFAULT_SCAN_BATCH_SIZE = 64;

/**
 * Shared source/session ownership for all viewer modes.
 *
 * Flow and free-canvas views may keep independent layout/camera state, but
 * source selection and scanning belong to this workspace so switching views
 * never requires a second native picker invocation or a second scan.
 */
export class ViewerWorkspaceController {
  readonly #sessionController: MediaSessionController;
  readonly #sourcePicker: SourcePickerPort;
  readonly #scanBatchSize: number;
  readonly #listeners = new Set<ViewerWorkspaceListener>();
  readonly #unsubscribeSession: () => void;

  #sourceDisplayName: string | null = null;
  #pickGeneration = 0;
  #disposed = false;

  constructor(
    sessionController: MediaSessionController,
    sourcePicker: SourcePickerPort,
    options: ViewerWorkspaceOptions = {},
  ) {
    const scanBatchSize = options.scanBatchSize ?? DEFAULT_SCAN_BATCH_SIZE;
    if (!Number.isInteger(scanBatchSize) || scanBatchSize <= 0) {
      throw new RangeError("scanBatchSize must be a positive integer");
    }

    this.#sessionController = sessionController;
    this.#sourcePicker = sourcePicker;
    this.#scanBatchSize = scanBatchSize;
    this.#unsubscribeSession = sessionController.subscribe(() => {
      this.#publish();
    });
  }

  get currentSession(): MediaSession | null {
    return this.#sessionController.current;
  }

  get sourceDisplayName(): string | null {
    return this.#sourceDisplayName;
  }

  get snapshot(): ViewerWorkspaceSnapshot {
    const session = this.#sessionController.current;
    return {
      sourceDisplayName: this.#sourceDisplayName,
      sessionId: session?.id ?? null,
      scanState: session === null ? null : cloneScanState(session.scanState),
      itemCount: session?.items.sourceSize ?? 0,
    };
  }

  subscribe(listener: ViewerWorkspaceListener): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async pickAndOpenSource(): Promise<boolean> {
    this.#assertActive();
    const generation = ++this.#pickGeneration;
    const picked = await this.#sourcePicker.pickDirectory();
    if (
      this.#disposed ||
      generation !== this.#pickGeneration ||
      picked === null
    ) {
      return false;
    }

    const previousDisplayName = this.#sourceDisplayName;
    this.#sourceDisplayName = picked.displayName;
    try {
      this.#sessionController.openSource(picked.source, this.#scanBatchSize);
    } catch (error) {
      this.#sourceDisplayName = previousDisplayName;
      this.#publish();
      throw error;
    }
    return true;
  }

  async cancelScan(): Promise<boolean> {
    this.#assertActive();
    return this.#sessionController.cancelCurrent();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#pickGeneration += 1;
    this.#unsubscribeSession();
    this.#listeners.clear();
  }

  #publish(): void {
    if (this.#disposed) {
      return;
    }
    const snapshot = this.snapshot;
    for (const listener of [...this.#listeners]) {
      listener(snapshot);
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("viewer workspace controller is disposed");
    }
  }
}

function cloneScanState(state: ScanState): ScanState {
  return {
    ...state,
    summary: state.summary === null ? null : { ...state.summary },
    error: state.error === null ? null : { ...state.error },
  };
}
