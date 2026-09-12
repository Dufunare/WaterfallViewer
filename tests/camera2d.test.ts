import { describe, expect, it } from "vitest";

import { Camera2D } from "../src/layout/canvas/camera2d";

describe("Camera2D", () => {
  it("round-trips world and screen coordinates", () => {
    const camera = new Camera2D({
      center: { x: 100, y: -50 },
      zoom: 2,
      viewport: { width: 800, height: 600 },
    });

    const world = { x: 135, y: -5 };
    const screen = camera.worldToScreen(world);
    expect(screen).toEqual({ x: 470, y: 390 });
    expect(camera.screenToWorld(screen)).toEqual(world);
  });

  it("keeps the world point under the cursor fixed while zooming", () => {
    const camera = new Camera2D({
      viewport: { width: 1000, height: 800 },
      zoom: 1,
    });
    const anchor = { x: 750, y: 200 };
    const worldBefore = camera.screenToWorld(anchor);

    camera.zoomAtScreen(4, anchor);

    expect(camera.screenToWorld(anchor).x).toBeCloseTo(worldBefore.x);
    expect(camera.screenToWorld(anchor).y).toBeCloseTo(worldBefore.y);
    expect(camera.worldToScreen(worldBefore).x).toBeCloseTo(anchor.x);
    expect(camera.worldToScreen(worldBefore).y).toBeCloseTo(anchor.y);
  });

  it("pans in screen space independent of zoom", () => {
    const camera = new Camera2D({
      viewport: { width: 400, height: 300 },
      zoom: 2,
    });

    camera.panByScreen({ x: 40, y: -20 });

    expect(camera.center).toEqual({ x: -20, y: 10 });
  });

  it("clamps zoom and preserves the anchor at the clamped value", () => {
    const camera = new Camera2D({
      viewport: { width: 400, height: 300 },
      zoom: 1,
      minZoom: 0.5,
      maxZoom: 4,
    });
    const anchor = { x: 50, y: 60 };
    const worldBefore = camera.screenToWorld(anchor);

    camera.zoomAtScreen(100, anchor);

    expect(camera.zoom).toBe(4);
    expect(camera.screenToWorld(anchor).x).toBeCloseTo(worldBefore.x);
    expect(camera.screenToWorld(anchor).y).toBeCloseTo(worldBefore.y);
  });

  it("expresses overscan in screen pixels and converts it to world units", () => {
    const camera = new Camera2D({
      center: { x: 100, y: 100 },
      viewport: { width: 200, height: 100 },
      zoom: 2,
    });

    expect(camera.visibleWorldRect(20)).toEqual({
      x: 40,
      y: 65,
      width: 120,
      height: 70,
    });
  });

  it("rejects invalid zoom ranges and viewport dimensions", () => {
    expect(
      () =>
        new Camera2D({
          minZoom: 2,
          maxZoom: 1,
        }),
    ).toThrow(/maxZoom/);

    expect(() =>
      new Camera2D({ viewport: { width: 0, height: 100 } }),
    ).toThrow(/viewport.width/);
  });
});
