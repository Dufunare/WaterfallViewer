import type { BrowserTile } from "../application/browser/mediaBrowserController";

interface RetainedEntry {
  tile: BrowserTile;
  usedAt: number;
}

/**
 * Keep recently revealed Flow tiles alive after they leave the controller's
 * compact loading window. This mirrors the old frontend's retained Image/wrap
 * objects without allowing an arbitrarily large library to grow the DOM forever.
 */
export class FlowRetainedTileCache {
  readonly #entries = new Map<string, RetainedEntry>();
  #sequence = 0;
  #sessionId: string | null = null;

  constructor(readonly maxEntries = 800) {
    if (!Number.isInteger(maxEntries) || maxEntries < 0) {
      throw new RangeError("maxEntries must be a non-negative integer");
    }
  }

  resetForSession(sessionId: string | null): boolean {
    if (sessionId === this.#sessionId) {
      return false;
    }
    this.#sessionId = sessionId;
    this.clear();
    return true;
  }

  retain(tile: BrowserTile): void {
    if (this.maxEntries === 0 || tile.thumbnailStatus !== "ready" || !tile.thumbnailUri) {
      return;
    }
    this.#entries.set(tile.mediaId, {
      tile: { ...tile },
      usedAt: ++this.#sequence,
    });
    this.#prune();
  }

  /** Refresh geometry/metadata for retained tiles when they re-enter a snapshot. */
  updateCurrent(tiles: readonly BrowserTile[]): void {
    for (const tile of tiles) {
      const entry = this.#entries.get(tile.mediaId);
      if (entry === undefined) {
        continue;
      }
      entry.tile = { ...tile };
      entry.usedAt = ++this.#sequence;
    }
  }

  historicalExcluding(currentIds: ReadonlySet<string>): BrowserTile[] {
    return [...this.#entries.values()]
      .filter((entry) => !currentIds.has(entry.tile.mediaId))
      .sort((left, right) => left.tile.y - right.tile.y || left.tile.x - right.tile.x)
      .map((entry) => ({ ...entry.tile }));
  }

  has(mediaId: string): boolean {
    return this.#entries.has(mediaId);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  #prune(): void {
    const excess = this.#entries.size - this.maxEntries;
    if (excess <= 0) {
      return;
    }
    const oldest = [...this.#entries.entries()]
      .sort((left, right) => left[1].usedAt - right[1].usedAt)
      .slice(0, excess);
    for (const [mediaId] of oldest) {
      this.#entries.delete(mediaId);
    }
  }
}
