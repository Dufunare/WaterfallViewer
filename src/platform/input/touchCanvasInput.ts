import type { InputPoint, ViewerInputAction } from "./actions";
import type { InputBounds } from "./desktopCanvasInput";

export interface TouchPointerInput {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface TouchPointerStartResult {
  accepted: boolean;
  pointerId: number | null;
}

const TAP_MOVE_THRESHOLD_PX = 4;
const MAX_TOUCH_POINTERS = 2;

/**
 * Touch gesture adapter for the free canvas.
 *
 * One contact produces pan or tap-to-select. Two contacts produce pan + zoom
 * actions around the touch midpoint. No mobile-specific behavior leaks into
 * the Canvas browser/application controller.
 */
export class TouchCanvasInputAdapter {
  readonly #contacts = new Map<number, InputPoint>();

  #singleStart: InputPoint | null = null;
  #lastSingle: InputPoint | null = null;
  #lastPinchCenter: InputPoint | null = null;
  #lastPinchDistance: number | null = null;
  #gestureMoved = false;
  #hadMultiTouch = false;

  get activePointerCount(): number {
    return this.#contacts.size;
  }

  beginPointer(input: TouchPointerInput): TouchPointerStartResult {
    if (this.#contacts.has(input.pointerId) || this.#contacts.size >= MAX_TOUCH_POINTERS) {
      return { accepted: false, pointerId: null };
    }

    const point = pointFrom(input);
    this.#contacts.set(input.pointerId, point);

    if (this.#contacts.size === 1) {
      this.#singleStart = point;
      this.#lastSingle = point;
      this.#gestureMoved = false;
      this.#hadMultiTouch = false;
      this.#lastPinchCenter = null;
      this.#lastPinchDistance = null;
    } else {
      this.#hadMultiTouch = true;
      this.#gestureMoved = true;
      this.#capturePinchBaseline();
    }

    return { accepted: true, pointerId: input.pointerId };
  }

  movePointer(
    input: TouchPointerInput,
    bounds: InputBounds,
  ): readonly ViewerInputAction[] {
    if (!this.#contacts.has(input.pointerId)) {
      return [];
    }
    this.#contacts.set(input.pointerId, pointFrom(input));

    if (this.#contacts.size === 2) {
      return this.#pinchActions(bounds);
    }

    const point = this.#contacts.values().next().value as InputPoint | undefined;
    if (point === undefined || this.#lastSingle === null) {
      return [];
    }

    if (!this.#gestureMoved && this.#singleStart !== null) {
      if (distance(this.#singleStart, point) < TAP_MOVE_THRESHOLD_PX) {
        this.#lastSingle = point;
        return [];
      }
      this.#gestureMoved = true;
    }

    const delta = subtract(point, this.#lastSingle);
    this.#lastSingle = point;
    if (delta.x === 0 && delta.y === 0) {
      return [];
    }
    return [{ type: "pan", delta }];
  }

  endPointer(
    input: TouchPointerInput,
    bounds: InputBounds,
  ): readonly ViewerInputAction[] {
    if (!this.#contacts.has(input.pointerId)) {
      return [];
    }

    const wasSingleTap =
      this.#contacts.size === 1 && !this.#gestureMoved && !this.#hadMultiTouch;
    const releasePoint = pointFrom(input);
    this.#contacts.delete(input.pointerId);

    if (this.#contacts.size === 1) {
      const remaining = this.#contacts.values().next().value as InputPoint;
      this.#singleStart = remaining;
      this.#lastSingle = remaining;
      this.#lastPinchCenter = null;
      this.#lastPinchDistance = null;
    } else if (this.#contacts.size === 0) {
      this.#resetGestureState();
    }

    if (!wasSingleTap) {
      return [];
    }
    return [
      {
        type: "select-at",
        point: localPoint(releasePoint, bounds),
        mode: "replace",
      },
    ];
  }

  cancelPointer(pointerId: number): boolean {
    if (!this.#contacts.delete(pointerId)) {
      return false;
    }
    if (this.#contacts.size === 1) {
      const remaining = this.#contacts.values().next().value as InputPoint;
      this.#singleStart = remaining;
      this.#lastSingle = remaining;
      this.#gestureMoved = true;
      this.#hadMultiTouch = true;
      this.#lastPinchCenter = null;
      this.#lastPinchDistance = null;
    } else if (this.#contacts.size === 0) {
      this.#resetGestureState();
    }
    return true;
  }

  reset(): void {
    this.#contacts.clear();
    this.#resetGestureState();
  }

  #capturePinchBaseline(): void {
    const pair = firstTwo(this.#contacts);
    if (pair === null) {
      return;
    }
    this.#lastPinchCenter = midpoint(pair[0], pair[1]);
    this.#lastPinchDistance = distance(pair[0], pair[1]);
  }

  #pinchActions(bounds: InputBounds): readonly ViewerInputAction[] {
    const pair = firstTwo(this.#contacts);
    if (pair === null) {
      return [];
    }

    const center = midpoint(pair[0], pair[1]);
    const pinchDistance = distance(pair[0], pair[1]);
    const previousCenter = this.#lastPinchCenter;
    const previousDistance = this.#lastPinchDistance;
    this.#lastPinchCenter = center;
    this.#lastPinchDistance = pinchDistance;

    if (previousCenter === null || previousDistance === null) {
      return [];
    }

    const actions: ViewerInputAction[] = [];
    const panDelta = subtract(center, previousCenter);
    if (panDelta.x !== 0 || panDelta.y !== 0) {
      actions.push({ type: "pan", delta: panDelta });
    }

    if (previousDistance > 0 && pinchDistance > 0) {
      const factor = pinchDistance / previousDistance;
      if (Number.isFinite(factor) && factor > 0 && factor !== 1) {
        actions.push({
          type: "zoom",
          factor,
          anchor: localPoint(center, bounds),
        });
      }
    }
    return actions;
  }

  #resetGestureState(): void {
    this.#singleStart = null;
    this.#lastSingle = null;
    this.#lastPinchCenter = null;
    this.#lastPinchDistance = null;
    this.#gestureMoved = false;
    this.#hadMultiTouch = false;
  }
}

function pointFrom(input: TouchPointerInput): InputPoint {
  return { x: input.clientX, y: input.clientY };
}

function localPoint(point: InputPoint, bounds: InputBounds): InputPoint {
  return { x: point.x - bounds.left, y: point.y - bounds.top };
}

function subtract(a: InputPoint, b: InputPoint): InputPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

function midpoint(a: InputPoint, b: InputPoint): InputPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: InputPoint, b: InputPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function firstTwo(
  contacts: ReadonlyMap<number, InputPoint>,
): readonly [InputPoint, InputPoint] | null {
  const iterator = contacts.values();
  const first = iterator.next().value as InputPoint | undefined;
  const second = iterator.next().value as InputPoint | undefined;
  return first === undefined || second === undefined ? null : [first, second];
}
