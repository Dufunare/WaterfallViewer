import { describe, expect, it } from "vitest";

import {
  AssetLeasePool,
  type AssetLeaseBackend,
} from "../src/renderers/pixi/assetLeasePool";

interface TestAsset {
  key: string;
  generation: number;
}

class ImmediateBackend implements AssetLeaseBackend<TestAsset> {
  readonly loads: string[] = [];
  readonly unloads: TestAsset[] = [];

  async load(key: string): Promise<TestAsset> {
    this.loads.push(key);
    return { key, generation: this.loads.length };
  }

  unload(_key: string, asset: TestAsset): void {
    this.unloads.push(asset);
  }
}

interface DeferredLoad {
  key: string;
  resolve: (asset: TestAsset) => void;
}

class DeferredBackend implements AssetLeaseBackend<TestAsset> {
  readonly loads: DeferredLoad[] = [];
  readonly unloads: TestAsset[] = [];

  load(key: string): Promise<TestAsset> {
    return new Promise((resolve) => {
      this.loads.push({ key, resolve });
    });
  }

  unload(_key: string, asset: TestAsset): void {
    this.unloads.push(asset);
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("AssetLeasePool", () => {
  it("shares one load across multiple leases and unloads at the final release", async () => {
    const backend = new ImmediateBackend();
    const pool = new AssetLeasePool(backend);

    const first = pool.acquire("image-a");
    const second = pool.acquire("image-a");
    expect(pool.refs("image-a")).toBe(2);
    expect(pool.telemetrySnapshot()).toEqual({
      entries: 1,
      totalRefs: 2,
      unloadingEntries: 0,
    });
    expect(await first).toBe(await second);
    expect(backend.loads).toEqual(["image-a"]);

    expect(pool.release("image-a")).toBe(true);
    await flushMicrotasks();
    expect(backend.unloads).toEqual([]);
    expect(pool.refs("image-a")).toBe(1);
    expect(pool.telemetrySnapshot()).toEqual({
      entries: 1,
      totalRefs: 1,
      unloadingEntries: 0,
    });

    expect(pool.release("image-a")).toBe(true);
    expect(pool.telemetrySnapshot()).toEqual({
      entries: 1,
      totalRefs: 0,
      unloadingEntries: 1,
    });
    await flushMicrotasks();
    expect(backend.unloads).toHaveLength(1);
    expect(pool.size).toBe(0);
    expect(pool.telemetrySnapshot()).toEqual({
      entries: 0,
      totalRefs: 0,
      unloadingEntries: 0,
    });
  });

  it("releases an asset that finishes loading after its last consumer left", async () => {
    const backend = new DeferredBackend();
    const pool = new AssetLeasePool(backend);

    const loading = pool.acquire("slow-image");
    await flushMicrotasks();
    expect(backend.loads).toHaveLength(1);
    expect(pool.release("slow-image")).toBe(true);
    expect(pool.telemetrySnapshot()).toEqual({
      entries: 1,
      totalRefs: 0,
      unloadingEntries: 1,
    });

    const asset = { key: "slow-image", generation: 1 };
    backend.loads[0].resolve(asset);
    await expect(loading).resolves.toEqual(asset);
    await flushMicrotasks();

    expect(backend.unloads).toEqual([asset]);
    expect(pool.size).toBe(0);
  });

  it("waits for an old generation to unload before reloading the same key", async () => {
    const backend = new DeferredBackend();
    const pool = new AssetLeasePool(backend);

    const first = pool.acquire("image-a");
    await flushMicrotasks();
    pool.release("image-a");
    const second = pool.acquire("image-a");

    expect(backend.loads).toHaveLength(1);
    expect(pool.telemetrySnapshot()).toEqual({
      entries: 1,
      totalRefs: 1,
      unloadingEntries: 0,
    });
    const firstAsset = { key: "image-a", generation: 1 };
    backend.loads[0].resolve(firstAsset);
    await expect(first).resolves.toEqual(firstAsset);
    await flushMicrotasks();

    expect(backend.unloads).toEqual([firstAsset]);
    expect(backend.loads).toHaveLength(2);
    const secondAsset = { key: "image-a", generation: 2 };
    backend.loads[1].resolve(secondAsset);
    await expect(second).resolves.toEqual(secondAsset);
    expect(pool.refs("image-a")).toBe(1);

    pool.release("image-a");
    await flushMicrotasks();
    expect(backend.unloads).toEqual([firstAsset, secondAsset]);
  });

  it("releaseAll drains every outstanding reference", async () => {
    const backend = new ImmediateBackend();
    const pool = new AssetLeasePool(backend);

    await Promise.all([
      pool.acquire("a"),
      pool.acquire("a"),
      pool.acquire("b"),
    ]);
    expect(pool.telemetrySnapshot()).toEqual({
      entries: 2,
      totalRefs: 3,
      unloadingEntries: 0,
    });
    pool.releaseAll();
    expect(pool.telemetrySnapshot()).toEqual({
      entries: 2,
      totalRefs: 0,
      unloadingEntries: 2,
    });
    await flushMicrotasks();

    expect(pool.size).toBe(0);
    expect(backend.unloads.map((asset) => asset.key).sort()).toEqual(["a", "b"]);
  });

  it("rejects empty keys and ignores duplicate release calls", async () => {
    const backend = new ImmediateBackend();
    const pool = new AssetLeasePool(backend);

    expect(() => pool.acquire(" ")).toThrow(/asset key/);
    await pool.acquire("a");
    expect(pool.release("a")).toBe(true);
    expect(pool.release("a")).toBe(false);
  });
});
