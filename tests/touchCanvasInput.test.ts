import { describe, expect, it } from "vitest";

import { TouchCanvasInputAdapter } from "../src/platform/input/touchCanvasInput";

function touch(pointerId: number, clientX: number, clientY: number) {
  return { pointerId, clientX, clientY };
}

const bounds = { left: 20, top: 10 };

describe("TouchCanvasInputAdapter", () => {
  it("maps a stationary single-finger tap to replace selection", () => {
    const input = new TouchCanvasInputAdapter();

    expect(input.beginPointer(touch(1, 70, 50))).toEqual({
      accepted: true,
      pointerId: 1,
    });
    expect(input.endPointer(touch(1, 70, 50), bounds)).toEqual([
      {
        type: "select-at",
        point: { x: 50, y: 40 },
        mode: "replace",
      },
    ]);
    expect(input.activePointerCount).toBe(0);
  });

  it("turns one-finger movement into pan without selecting on release", () => {
    const input = new TouchCanvasInputAdapter();
    input.beginPointer(touch(1, 100, 100));

    expect(input.movePointer(touch(1, 102, 101), bounds)).toEqual([]);
    expect(input.movePointer(touch(1, 110, 104), bounds)).toEqual([
      { type: "pan", delta: { x: 8, y: 3 } },
    ]);
    expect(input.endPointer(touch(1, 110, 104), bounds)).toEqual([]);
  });

  it("maps two-finger midpoint movement and distance change to pan plus zoom", () => {
    const input = new TouchCanvasInputAdapter();
    input.beginPointer(touch(1, 100, 100));
    input.beginPointer(touch(2, 200, 100));

    const actions = input.movePointer(touch(2, 220, 120), bounds);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({
      type: "pan",
      delta: { x: 10, y: 10 },
    });
    expect(actions[1]?.type).toBe("zoom");
    if (actions[1]?.type === "zoom") {
      expect(actions[1].factor).toBeCloseTo(Math.hypot(120, 20) / 100);
      expect(actions[1].anchor).toEqual({ x: 140, y: 100 });
    }

    expect(input.endPointer(touch(2, 220, 120), bounds)).toEqual([]);
    expect(input.endPointer(touch(1, 100, 100), bounds)).toEqual([]);
  });

  it("continues as pan after a pinch finger leaves without producing a tap", () => {
    const input = new TouchCanvasInputAdapter();
    input.beginPointer(touch(1, 100, 100));
    input.beginPointer(touch(2, 200, 100));
    input.endPointer(touch(2, 200, 100), bounds);

    expect(input.movePointer(touch(1, 110, 105), bounds)).toEqual([
      { type: "pan", delta: { x: 10, y: 5 } },
    ]);
    expect(input.endPointer(touch(1, 110, 105), bounds)).toEqual([]);
  });

  it("cancellation never synthesizes selection", () => {
    const input = new TouchCanvasInputAdapter();
    input.beginPointer(touch(1, 80, 80));

    expect(input.cancelPointer(1)).toBe(true);
    expect(input.activePointerCount).toBe(0);
    expect(input.cancelPointer(1)).toBe(false);
  });

  it("bounds the gesture to two tracked contacts", () => {
    const input = new TouchCanvasInputAdapter();
    input.beginPointer(touch(1, 0, 0));
    input.beginPointer(touch(2, 10, 0));

    expect(input.beginPointer(touch(3, 20, 0))).toEqual({
      accepted: false,
      pointerId: null,
    });
    expect(input.activePointerCount).toBe(2);
  });
});
