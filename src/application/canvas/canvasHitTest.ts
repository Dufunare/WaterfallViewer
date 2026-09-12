import type { CanvasBrowserItem } from "./canvasBrowserController";
import type { Point2D } from "../../layout/canvas/camera2d";

/**
 * Returns the topmost currently-rendered media item under a screen point.
 *
 * CanvasBrowserController already spatially culls its snapshot, so interaction
 * work stays bounded by the render set instead of querying the full scene.
 */
export function hitTestCanvasItems(
  items: readonly CanvasBrowserItem[],
  point: Point2D,
): CanvasBrowserItem | null {
  requireFinite(point.x, "point.x");
  requireFinite(point.y, "point.y");

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const rect = item.screenRect;
    if (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    ) {
      return { ...item, worldRect: { ...item.worldRect }, screenRect: { ...rect } };
    }
  }
  return null;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
}
