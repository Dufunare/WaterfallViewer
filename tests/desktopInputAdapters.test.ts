import { describe, expect, it } from "vitest";

import { DesktopCanvasInputAdapter } from "../src/platform/input/desktopCanvasInput";
import { mapDesktopPreviewKey } from "../src/platform/input/desktopPreviewInput";

function pointer(
  pointerId: number,
  clientX: number,
  clientY: number,
  button = 0,
) {
  return { pointerId, clientX, clientY, button };
}

describe("DesktopCanvasInputAdapter", () => {
  it("turns an accepted pointer drag into pan actions", () => {
    const input = new DesktopCanvasInputAdapter();

    expect(input.beginPointer(pointer(4, 100, 200))).toEqual({
      accepted: true,
      pointerId: 4,
    });
    expect(input.movePointer(pointer(4, 112, 193))).toEqual({
      type: "pan",
      delta: { x: 12, y: -7 },
    });
    expect(input.movePointer(pointer(4, 112, 193))).toBeNull();
    expect(input.endPointer(4)).toBe(true);
    expect(input.movePointer(pointer(4, 120, 210))).toBeNull();
  });

  it("ignores unsupported buttons and unrelated pointer ids", () => {
    const input = new DesktopCanvasInputAdapter();

    expect(input.beginPointer(pointer(1, 0, 0, 2))).toEqual({
      accepted: false,
      pointerId: null,
    });
    input.beginPointer(pointer(2, 5, 8, 1));
    expect(input.movePointer(pointer(3, 10, 10))).toBeNull();
    expect(input.endPointer(3)).toBe(false);
    expect(input.endPointer(2)).toBe(true);
  });

  it("maps wheel and activation coordinates into local semantic actions", () => {
    const input = new DesktopCanvasInputAdapter();
    const bounds = { left: 40, top: 20 };

    const zoom = input.wheel(
      { clientX: 140, clientY: 70, deltaY: -120 },
      bounds,
    );
    expect(zoom.type).toBe("zoom");
    if (zoom.type === "zoom") {
      expect(zoom.factor).toBeGreaterThan(1);
      expect(zoom.anchor).toEqual({ x: 100, y: 50 });
    }

    expect(input.activate({ clientX: 60, clientY: 55 }, bounds)).toEqual({
      type: "activate-at",
      point: { x: 20, y: 35 },
    });
  });

  it("bounds extreme wheel deltas", () => {
    const input = new DesktopCanvasInputAdapter();
    const bounds = { left: 0, top: 0 };
    const zoomIn = input.wheel({ clientX: 0, clientY: 0, deltaY: -1_000_000 }, bounds);
    const zoomOut = input.wheel({ clientX: 0, clientY: 0, deltaY: 1_000_000 }, bounds);

    expect(zoomIn.type === "zoom" && zoomIn.factor).toBeCloseTo(Math.exp(2));
    expect(zoomOut.type === "zoom" && zoomOut.factor).toBeCloseTo(Math.exp(-2));
  });
});

describe("mapDesktopPreviewKey", () => {
  const base = {
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    keepsNativeArrowBehavior: false,
  };

  it("maps escape and available adjacent navigation", () => {
    expect(
      mapDesktopPreviewKey(
        { ...base, key: "Escape" },
        { hasPrevious: false, hasNext: false },
      ),
    ).toEqual({ type: "back" });
    expect(
      mapDesktopPreviewKey(
        { ...base, key: "ArrowLeft" },
        { hasPrevious: true, hasNext: true },
      ),
    ).toEqual({ type: "previous" });
    expect(
      mapDesktopPreviewKey(
        { ...base, key: "ArrowRight" },
        { hasPrevious: true, hasNext: true },
      ),
    ).toEqual({ type: "next" });
  });

  it("preserves native controls and modified keyboard input", () => {
    expect(
      mapDesktopPreviewKey(
        { ...base, key: "ArrowLeft", keepsNativeArrowBehavior: true },
        { hasPrevious: true, hasNext: true },
      ),
    ).toBeNull();
    expect(
      mapDesktopPreviewKey(
        { ...base, key: "ArrowRight", ctrlKey: true },
        { hasPrevious: true, hasNext: true },
      ),
    ).toBeNull();
    expect(
      mapDesktopPreviewKey(
        { ...base, key: "ArrowLeft" },
        { hasPrevious: false, hasNext: true },
      ),
    ).toBeNull();
  });
});
