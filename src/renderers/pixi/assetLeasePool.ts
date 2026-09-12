export interface AssetLeaseBackend<TAsset> {
  load(key: string): Promise<TAsset>;
  unload(key: string, asset: TAsset): Promise<void> | void;
}

interface LeaseEntry<TAsset> {
  refs: number;
  promise: Promise<TAsset>;
  unloading: Promise<void> | null;
}

/**
 * Reference-counted async asset ownership with safe reacquisition while an
 * older generation is unloading.
 */
export class AssetLeasePool<TAsset> {
  readonly #entries = new Map<string, LeaseEntry<TAsset>>();

  constructor(private readonly backend: AssetLeaseBackend<TAsset>) {}

  get size(): number {
    return this.#entries.size;
  }

  refs(key: string): number {
    return this.#entries.get(key)?.refs ?? 0;
  }

  acquire(key: string): Promise<TAsset> {
    validateKey(key);
    const existing = this.#entries.get(key);
    if (existing !== undefined && existing.unloading === null) {
      existing.refs += 1;
      return existing.promise;
    }

    const waitForPriorUnload = existing?.unloading ?? Promise.resolve();
    const entry: LeaseEntry<TAsset> = {
      refs: 1,
      promise: Promise.resolve(undefined as unknown as TAsset),
      unloading: null,
    };
    entry.promise = waitForPriorUnload
      .then(() => this.backend.load(key))
      .catch((error) => {
        if (this.#entries.get(key) === entry) {
          this.#entries.delete(key);
        }
        throw error;
      });
    this.#entries.set(key, entry);
    return entry.promise;
  }

  release(key: string): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.refs === 0) {
      return false;
    }

    entry.refs -= 1;
    if (entry.refs > 0) {
      return true;
    }

    entry.unloading = entry.promise
      .then((asset) => this.backend.unload(key, asset))
      .catch(() => undefined)
      .then(() => undefined);

    void entry.unloading.finally(() => {
      if (this.#entries.get(key) === entry) {
        this.#entries.delete(key);
      }
    });
    return true;
  }

  releaseAll(): void {
    for (const [key, entry] of [...this.#entries]) {
      while (entry.refs > 0) {
        this.release(key);
      }
    }
  }
}

function validateKey(key: string): void {
  if (key.trim().length === 0) {
    throw new RangeError("asset key must not be empty");
  }
}
