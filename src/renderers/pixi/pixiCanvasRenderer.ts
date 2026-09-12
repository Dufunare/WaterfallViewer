import {
  Application,
  Container,
  Sprite,
  Texture,
} from "pixi.js";

import type {
  CanvasBrowserItem,
  CanvasBrowserSnapshot,
  CanvasRepresentationStatus,
} from "../../application/canvas/canvasBrowserController";
import { AssetLeasePool } from "./assetLeasePool";
import { PixiImageTextureBackend } from "./imageTextureBackend";

interface TileRecord {
  container: Container;
  background: Sprite;
  sprite: Sprite | null;
  currentUri: string | null;
  desiredUri: string | null;
  failedUri: string | null;
  loadRevision: number;
}

export interface PixiCanvasRendererOptions {
  powerPreference?: "high-performance" | "low-power";
}

/**
 * Thin PixiJS adapter over `CanvasBrowserSnapshot`.
 *
 * Camera math, culling, LOD, representation selection and resource priority
 * are intentionally handled before this layer. Pixi receives only the bounded
 * screen-space render set and owns display objects + GPU texture lifetimes.
 */
export class PixiCanvasRenderer {
  readonly #options: PixiCanvasRendererOptions;
  readonly #textures = new AssetLeasePool(new PixiImageTextureBackend());
  readonly #records = new Map<string, TileRecord>();

  #app: Application | null = null;
  #host: HTMLElement | null = null;
  #frame: number | null = null;
  #disposed = false;

  constructor(options: PixiCanvasRendererOptions = {}) {
    this.#options = { ...options };
  }

  get initialized(): boolean {
    return this.#app !== null;
  }

  get renderedItemCount(): number {
    return this.#records.size;
  }

  async init(host: HTMLElement): Promise<void> {
    this.#assertActive();
    if (this.#app !== null) {
      throw new Error("Pixi canvas renderer is already initialized");
    }
    if (!(host instanceof HTMLElement)) {
      throw new TypeError("host must be an HTMLElement");
    }

    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const app = new Application();
    await app.init({
      width,
      height,
      resolution: Math.max(1, window.devicePixelRatio || 1),
      autoDensity: true,
      autoStart: false,
      antialias: false,
      backgroundAlpha: 0,
      preference: "webgl",
      powerPreference: this.#options.powerPreference ?? "high-performance",
      textureGCActive: true,
    });

    app.canvas.style.display = "block";
    app.canvas.style.width = "100%";
    app.canvas.style.height = "100%";
    app.canvas.style.touchAction = "none";
    host.appendChild(app.canvas);

    this.#host = host;
    this.#app = app;
    this.#queueRender();
  }

  update(snapshot: CanvasBrowserSnapshot): void {
    this.#assertReady();
    const app = this.#app!;
    const desiredIds = new Set(snapshot.items.map((item) => item.mediaId));

    for (const [mediaId, record] of [...this.#records]) {
      if (!desiredIds.has(mediaId)) {
        this.#removeRecord(mediaId, record);
      }
    }

    for (const item of snapshot.items) {
      let record = this.#records.get(item.mediaId);
      if (record === undefined) {
        record = this.#createRecord();
        this.#records.set(item.mediaId, record);
        app.stage.addChild(record.container);
      }
      this.#updateRecord(record, item);
    }

    const viewport = snapshot.camera.viewport;
    if (
      app.renderer.width !== Math.round(viewport.width * app.renderer.resolution) ||
      app.renderer.height !== Math.round(viewport.height * app.renderer.resolution)
    ) {
      app.renderer.resize(viewport.width, viewport.height);
    }
    this.#queueRender();
  }

  destroy(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    if (this.#frame !== null) {
      window.cancelAnimationFrame(this.#frame);
      this.#frame = null;
    }

    for (const [mediaId, record] of [...this.#records]) {
      this.#removeRecord(mediaId, record);
    }
    this.#textures.releaseAll();

    this.#app?.destroy({ removeView: true }, { children: true, context: true });
    this.#app = null;
    this.#host = null;
  }

  #createRecord(): TileRecord {
    const container = new Container();
    const background = new Sprite(Texture.WHITE);
    background.tint = 0x1d2026;
    container.addChild(background);
    return {
      container,
      background,
      sprite: null,
      currentUri: null,
      desiredUri: null,
      failedUri: null,
      loadRevision: 0,
    };
  }

  #updateRecord(record: TileRecord, item: CanvasBrowserItem): void {
    record.container.position.set(item.screenRect.x, item.screenRect.y);
    record.background.width = item.screenRect.width;
    record.background.height = item.screenRect.height;
    record.background.tint = backgroundTint(item.representationStatus);
    record.background.alpha = item.priority === "overscan" ? 0.78 : 1;

    if (record.sprite !== null) {
      record.sprite.width = item.screenRect.width;
      record.sprite.height = item.screenRect.height;
      record.sprite.alpha = item.priority === "overscan" ? 0.9 : 1;
    }

    const uri = item.representationUri;
    if (uri === null) {
      this.#detachTexture(record);
      record.failedUri = null;
      return;
    }

    if (record.currentUri === uri || record.desiredUri === uri || record.failedUri === uri) {
      return;
    }

    this.#beginTextureLoad(record, uri, item);
  }

  #beginTextureLoad(
    record: TileRecord,
    uri: string,
    item: CanvasBrowserItem,
  ): void {
    const revision = ++record.loadRevision;
    record.desiredUri = uri;
    record.failedUri = null;

    void this.#textures.acquire(uri).then(
      (texture) => {
        if (
          this.#disposed ||
          record.loadRevision !== revision ||
          record.desiredUri !== uri
        ) {
          this.#textures.release(uri);
          return;
        }

        this.#detachCurrentSprite(record);
        const sprite = new Sprite(texture);
        sprite.width = item.screenRect.width;
        sprite.height = item.screenRect.height;
        sprite.alpha = item.priority === "overscan" ? 0.9 : 1;
        record.container.addChild(sprite);
        record.sprite = sprite;
        record.currentUri = uri;
        record.desiredUri = null;
        this.#queueRender();
      },
      () => {
        if (record.loadRevision !== revision || record.desiredUri !== uri) {
          return;
        }
        record.desiredUri = null;
        record.failedUri = uri;
        record.background.tint = 0x3a2428;
        this.#queueRender();
      },
    );
  }

  #detachTexture(record: TileRecord): void {
    record.loadRevision += 1;
    record.desiredUri = null;
    this.#detachCurrentSprite(record);
  }

  #detachCurrentSprite(record: TileRecord): void {
    if (record.sprite !== null) {
      record.container.removeChild(record.sprite);
      record.sprite.destroy();
      record.sprite = null;
    }
    if (record.currentUri !== null) {
      this.#textures.release(record.currentUri);
      record.currentUri = null;
    }
  }

  #removeRecord(mediaId: string, record: TileRecord): void {
    record.loadRevision += 1;
    record.desiredUri = null;
    this.#detachCurrentSprite(record);
    record.container.removeFromParent();
    record.container.destroy({ children: true });
    this.#records.delete(mediaId);
  }

  #queueRender(): void {
    if (this.#frame !== null || this.#disposed || this.#app === null) {
      return;
    }
    this.#frame = window.requestAnimationFrame(() => {
      this.#frame = null;
      if (!this.#disposed && this.#app !== null) {
        this.#app.render();
      }
    });
  }

  #assertReady(): void {
    this.#assertActive();
    if (this.#app === null || this.#host === null) {
      throw new Error("Pixi canvas renderer has not been initialized");
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("Pixi canvas renderer is disposed");
    }
  }
}

function backgroundTint(status: CanvasRepresentationStatus): number {
  switch (status) {
    case "error":
      return 0x3a2428;
    case "unsupported":
      return 0x262b34;
    case "placeholder":
      return 0x1b1e24;
    case "loading":
      return 0x20242b;
    case "ready":
      return 0x111318;
  }
}
