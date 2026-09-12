import { describe, expect, it } from "vitest";

import {
  hitTestCanvasItems,
} from "../src/application/canvas/canvasHitTest";
import type { CanvasBrowserItem } from "../src/application/canvas/canvasBrowserController";

function item(id: string, x: number, y: number, width = 100, height = 80): CanvasBrowserItem {
  return {
    mediaId: id,
    name: `${id}.jpg`,
    relativePath: `${id}.jpg`,
    kind: "image",
    worldRect: { x, y, width, height },
    screenRect: { x, y, width, height },
    lod: "thumbnail",
    priority: "visible",
    representationStatus: "placeholder",
    representationUri: null,
    representationError: null,
  };
}

describe("hitTestCanvasItems", () => {
  it("returns the media under the screen point", () => {
    const items = [item("a", 0, 0), item("b", 120, 0)];

    expect(hitTestCanvasItems(items, { x: 150, y: 30 })?.mediaId).toBe("b");
    expect(hitTestCanvasItems(items, { x: 300, y: 30 })).toBeNull();
  });

  it("chooses the last rendered item when projected rectangles overlap", () => {
    const items = [item("bottom", 0, 0), item("top", 20, 20)];

    expect(hitTestCanvasItems(items, { x: 40, y: 40 })?.mediaId).toBe("top");
  });

  it("treats rectangle edges as hittable and validates coordinates", () => {
    const items = [item("a", 10, 10, 20, 20)];

    expect(hitTestCanvasItems(items, { x: 30, y: 30 })?.mediaId).toBe("a");
    expect(() => hitTestCanvasItems(items, { x: Number.NaN, y: 0 })).toThrow(
      /point.x/,
    );
  });

  it("returns a clone rather than exposing snapshot geometry for mutation", () => {
    const source = item("a", 0, 0);
    const hit = hitTestCanvasItems([source], { x: 10, y: 10 })!;
    hit.screenRect.x = 999;

    expect(source.screenRect.x).toBe(0);
  });
});
