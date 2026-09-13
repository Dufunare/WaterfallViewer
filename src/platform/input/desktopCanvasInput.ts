import type { InputPoint, ViewerInputAction } from "./actions";

export interface PointerInput {
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export interface WheelInput {
  clientX: number;
  clientY: number;
  deltaY: number;
}

export interface MouseInput {
  clientX: number;
  clientY: number;
}

export interface InputBounds {
  left: number;
  top: number;
}

export interface PointerStartResult {
  accepted: boolean;
  pointerId: number | null;
}

/**
 * Stateful desktop gesture adapter for the free canvas.
 *
 * It owns mouse/pointer gesture interpretation only. The resulting actions are
 * platform-neutral and can later be produced by a touch adapter without
 * changing the canvas browser controller.
 */
export class DesktopCanvasInputAdapter {
  #activePointerId: number | null = null;
  #activeButton: number | null = null;
  #lastPointer: InputPoint | null = null;
  #moved = false;

  get activePointerId(): number | null {
    return this.#activePointerId;
  }

  beginPointer(input: PointerInput): PointerStartResult {
    if (input.button !== 0 && input.button !== 1) {
      return { accepted: false, pointerId: null };
    }

    this.#activePointerId = input.pointerId;
    this.#activeButton = input.button;
    this.#lastPointer = { x: input.clientX, y: input.clientY };
    this.#moved = false;
    return { accepted: true, pointerId: input.pointerId };
  }

  movePointer(input: PointerInput): ViewerInputAction | null {
    if (this.#activePointerId !== input.pointerId || this.#lastPointer === null) {
      return null;
    }

    const delta = {
      x: input.clientX - this.#lastPointer.x,
      y: input.clientY - this.#lastPointer.y,
    };
    this.#lastPointer = { x: input.clientX, y: input.clientY };
    if (delta.x === 0 && delta.y === 0) {
      return null;
    }
    this.#moved = true;
    return { type: "pan", delta };
  }

  selectionOnPointerUp(
    input: PointerInput,
    bounds: InputBounds,
  ): ViewerInputAction | null {
    if (
      this.#activePointerId !== input.pointerId ||
      this.#activeButton !== 0 ||
      this.#moved
    ) {
      return null;
    }
    return {
      type: "select-at",
      point: localPoint(input, bounds),
      mode: input.ctrlKey || input.metaKey ? "toggle" : "replace",
    };
  }

  endPointer(pointerId: number): boolean {
    if (this.#activePointerId !== pointerId) {
      return false;
    }
    this.#activePointerId = null;
    this.#activeButton = null;
    this.#lastPointer = null;
    this.#moved = false;
    return true;
  }

  wheel(input: WheelInput, bounds: InputBounds): ViewerInputAction {
    const exponent = Math.max(-2, Math.min(2, -input.deltaY * 0.0015));
    return {
      type: "zoom",
      factor: Math.exp(exponent),
      anchor: localPoint(input, bounds),
    };
  }

  activate(input: MouseInput, bounds: InputBounds): ViewerInputAction {
    return { type: "activate-at", point: localPoint(input, bounds) };
  }

  reset(): void {
    this.#activePointerId = null;
    this.#activeButton = null;
    this.#lastPointer = null;
    this.#moved = false;
  }
}

function localPoint(input: MouseInput, bounds: InputBounds): InputPoint {
  return {
    x: input.clientX - bounds.left,
    y: input.clientY - bounds.top,
  };
}
