export interface CanvasDomMediaTile {
  mediaId: string;
  name: string;
  relativePath: string;
  uri: string;
  x: number;
  y: number;
  width: number;
  height: number;
  sourceWidth: number | null;
  sourceHeight: number | null;
}

export interface CanvasDomViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TileRecord {
  root: HTMLDivElement;
  image: HTMLImageElement;
  tile: CanvasDomMediaTile;
  status: "idle" | "loading" | "decoded" | "failed" | "evicted";
  estimatedBytes: number;
}

const MAX_ACTIVE_TILES = 440;
const MAX_RETAINED_TILES = 220;
const MAX_RETAINED_DECODE_BYTES = 1024 * 1024 * 1024;
const MAX_CONCURRENT_DECODES = 8;
const NEW_LOADS_PER_MOVING_FRAME = 2;
const NEW_LOADS_PER_IDLE_FRAME = 8;

/**
 * DOM image lifecycle for the active free-canvas experiment.
 *
 * - Keeps the same DOM image while the camera moves in its overscan window.
 * - Retains recently visited image elements (and their decoded images) in an
 *   explicitly bounded LRU rather than reloading on every pan reversal.
 * - Schedules image decode ahead of entry into the viewport, prioritizing
 *   visible media and limiting new work during interaction.
 * - Owns no layout or media session state: replacing the session calls clear().
 *
 * Source images are used for compatibility with the experimental Flow transport.
 * The byte cap is an estimate from metadata, not a claim about exact process
 * memory/VRAM. The retained cap does not include currently visible media.
 */
export class CanvasDomTileCache {
  readonly #world: HTMLElement;
  readonly #active = new Map<string, TileRecord>();
  readonly #retained = new Map<string, TileRecord>();
  #retainedBytes = 0;
  #concurrentDecodes = 0;
  #loadFrame: number | null = null;
  #disposed = false;
  #moving = false;
  #view: CanvasDomViewRect = { x: 0, y: 0, width: 1, height: 1 };

  constructor(world: HTMLElement) {
    this.#world = world;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  get retainedCount(): number {
    return this.#retained.size;
  }

  update(
    tiles: readonly CanvasDomMediaTile[],
    view: CanvasDomViewRect,
    selectedIds: ReadonlySet<string>,
    moving: boolean,
  ): void {
    if (this.#disposed) return;
    this.#view = view;
    this.#moving = moving;

    // All on-screen media take priority over overscan tiles. A hard DOM cap
    // prevents an enormous window from exhausting memory on small-zoom views.
    const targets = tiles.length > MAX_ACTIVE_TILES
      ? [...tiles].sort((a, b) => priority(a, view) - priority(b, view))
        .slice(0, MAX_ACTIVE_TILES)
      : tiles;
    const targetIds = new Set(targets.map((tile) => tile.mediaId));
    for (const [id, record] of this.#active) {
      if (targetIds.has(id)) continue;
      record.root.remove();
      this.#active.delete(id);
      this.#retained.set(id, record);
      this.#retainedBytes += record.estimatedBytes;
    }

    const fragment = document.createDocumentFragment();
    for (const tile of targets) {
      let record = this.#active.get(tile.mediaId);
      if (record === undefined) {
        record = this.#retained.get(tile.mediaId);
        if (record !== undefined) {
          this.#retained.delete(tile.mediaId);
          this.#retainedBytes -= record.estimatedBytes;
        } else {
          record = createRecord(tile);
        }
        this.#active.set(tile.mediaId, record);
        fragment.appendChild(record.root);
      }
      // Positions are stable during streaming, but full projection rebuilds
      // can replace item geometry without reusing an old DOM node.
      if (record.tile.x !== tile.x || record.tile.y !== tile.y ||
          record.tile.width !== tile.width || record.tile.height !== tile.height) {
        place(record.root, tile);
      }
      record.tile = tile;
      record.root.classList.toggle("selected", selectedIds.has(tile.mediaId));
    }
    if (fragment.childNodes.length > 0) this.#world.appendChild(fragment);
    this.#pruneRetained();
    this.#scheduleLoads();
  }

  noteCamera(view: CanvasDomViewRect, moving: boolean): void {
    this.#view = view;
    this.#moving = moving;
    this.#scheduleLoads();
  }

  updateSelection(ids: ReadonlySet<string>): void {
    for (const [mediaId, record] of this.#active) {
      record.root.classList.toggle("selected", ids.has(mediaId));
    }
  }

  clear(): void {
    if (this.#loadFrame !== null) cancelAnimationFrame(this.#loadFrame);
    this.#loadFrame = null;
    for (const record of this.#active.values()) this.#evict(record);
    for (const record of this.#retained.values()) this.#evict(record);
    this.#active.clear();
    this.#retained.clear();
    this.#retainedBytes = 0;
    this.#concurrentDecodes = 0;
    this.#world.replaceChildren();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.clear();
  }

  #scheduleLoads(): void {
    if (this.#disposed || this.#loadFrame !== null ||
        this.#concurrentDecodes >= MAX_CONCURRENT_DECODES) return;
    if (![...this.#active.values()].some((record) => record.status === "idle")) return;
    this.#loadFrame = requestAnimationFrame(() => {
      this.#loadFrame = null;
      this.#flushLoads();
    });
  }

  #flushLoads(): void {
    if (this.#disposed) return;
    const slots = Math.min(
      MAX_CONCURRENT_DECODES - this.#concurrentDecodes,
      this.#moving ? NEW_LOADS_PER_MOVING_FRAME : NEW_LOADS_PER_IDLE_FRAME,
    );
    if (slots <= 0) return;

    const candidates = [...this.#active.values()]
      .filter((record) => record.status === "idle")
      .sort((a, b) => priority(a.tile, this.#view) - priority(b.tile, this.#view));

    for (const record of candidates.slice(0, slots)) {
      record.status = "loading";
      this.#concurrentDecodes++;
      // Unlike loading=lazy, decoding starts while the image is still in the
      // overscan region. Re-entering a retained tile does not set src again.
      record.image.src = record.tile.uri;
      void record.image.decode().then(
        () => this.#finishDecode(record, true),
        () => this.#finishDecode(record, false),
      );
    }
    this.#scheduleLoads();
  }

  #finishDecode(record: TileRecord, success: boolean): void {
    if (record.status !== "loading") return;
    record.status = success ? "decoded" : "failed";
    this.#concurrentDecodes--;
    this.#scheduleLoads();
  }

  #pruneRetained(): void {
    while (this.#retained.size > MAX_RETAINED_TILES ||
        this.#retainedBytes > MAX_RETAINED_DECODE_BYTES) {
      const oldest = this.#retained.entries().next().value as
        | [string, TileRecord] | undefined;
      if (oldest === undefined) break;
      this.#retained.delete(oldest[0]);
      this.#retainedBytes -= oldest[1].estimatedBytes;
      this.#evict(oldest[1]);
    }
  }

  #evict(record: TileRecord): void {
    if (record.status === "loading") this.#concurrentDecodes = Math.max(0, this.#concurrentDecodes - 1);
    record.status = "evicted";
    record.image.removeAttribute("src");
    record.root.remove();
  }
}

function createRecord(tile: CanvasDomMediaTile): TileRecord {
  const root = document.createElement("div");
  root.className = "canvas-media";
  root.dataset.canvasMediaId = tile.mediaId;
  root.title = tile.relativePath;
  place(root, tile);

  const image = document.createElement("img");
  image.alt = tile.name;
  image.draggable = false;
  image.decoding = "async";
  // Source assignment is explicitly controlled by the decode scheduler.
  image.loading = "eager";
  root.appendChild(image);
  return {
    root, image, tile, status: "idle",
    estimatedBytes: estimatedDecodeBytes(tile),
  };
}

function place(element: HTMLElement, tile: CanvasDomMediaTile): void {
  element.style.left = `${tile.x}px`;
  element.style.top = `${tile.y}px`;
  element.style.width = `${tile.width}px`;
  element.style.height = `${tile.height}px`;
}

function estimatedDecodeBytes(tile: CanvasDomMediaTile): number {
  if (tile.sourceWidth !== null && tile.sourceHeight !== null &&
      tile.sourceWidth > 0 && tile.sourceHeight > 0 &&
      Number.isFinite(tile.sourceWidth) && Number.isFinite(tile.sourceHeight)) {
    return Math.min(256 * 1024 * 1024, tile.sourceWidth * tile.sourceHeight * 4);
  }
  return 16 * 1024 * 1024;
}

function priority(tile: CanvasDomMediaTile, view: CanvasDomViewRect): number {
  const intersects = tile.x < view.x + view.width &&
    tile.x + tile.width > view.x &&
    tile.y < view.y + view.height &&
    tile.y + tile.height > view.y;
  const dx = tile.x + tile.width / 2 - (view.x + view.width / 2);
  const dy = tile.y + tile.height / 2 - (view.y + view.height / 2);
  return (intersects ? -1_000_000_000 : 0) + dx * dx + dy * dy;
}
