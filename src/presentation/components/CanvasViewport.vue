<script setup lang="ts">
import {
  computed,
  markRaw,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from "vue";

import type {
  CanvasBrowserController,
  CanvasBrowserSnapshot,
} from "../../application/canvas/canvasBrowserController";
import { hitTestCanvasItems } from "../../application/canvas/canvasHitTest";
import {
  DesktopCanvasInputAdapter,
  type InputBounds,
} from "../../platform/input/desktopCanvasInput";
import type { ViewerInputAction } from "../../platform/input/actions";
import { TouchCanvasInputAdapter } from "../../platform/input/touchCanvasInput";
import { PixiCanvasRenderer } from "../../renderers/pixi/pixiCanvasRenderer";
import { useMediaSelection } from "../selectionContext";

const props = defineProps<{
  createBrowser: () => CanvasBrowserController;
}>();
const emit = defineEmits<{
  activate: [mediaId: string];
}>();

const selection = useMediaSelection();
const host = ref<HTMLElement | null>(null);
const browser = markRaw(props.createBrowser());
const renderer = markRaw(new PixiCanvasRenderer());
const desktopInput = markRaw(new DesktopCanvasInputAdapter());
const touchInput = markRaw(new TouchCanvasInputAdapter());
const snapshot = shallowRef<CanvasBrowserSnapshot>(browser.snapshot);
const selectionSnapshot = shallowRef(selection.snapshot);
const rendererError = ref<string | null>(null);
const dragging = ref(false);

let unsubscribe: (() => void) | null = null;
let unsubscribeSelection: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeFrame: number | null = null;
let disposed = false;

const zoomLabel = computed(() => `${Math.round(snapshot.value.camera.zoom * 100)}%`);
const canFit = computed(() => snapshot.value.itemCount > 0);
const selectedItems = computed(() => {
  const selectedIds = new Set(selectionSnapshot.value.selectedIds);
  return snapshot.value.items.filter((item) => selectedIds.has(item.mediaId));
});

function selectionStyle(item: CanvasBrowserSnapshot["items"][number]): Record<string, string> {
  return {
    width: `${item.screenRect.width}px`,
    height: `${item.screenRect.height}px`,
    transform: `translate3d(${item.screenRect.x}px, ${item.screenRect.y}px, 0)`,
  };
}

function scheduleViewportSync(): void {
  if (resizeFrame !== null) {
    return;
  }
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = null;
    syncViewport();
  });
}

function syncViewport(): void {
  const element = host.value;
  if (element === null || element.clientWidth <= 0 || element.clientHeight <= 0) {
    return;
  }

  browser.setViewport({
    width: element.clientWidth,
    height: element.clientHeight,
    devicePixelRatio: Math.max(1, window.devicePixelRatio || 1),
  });
}

function onPointerDown(event: PointerEvent): void {
  const element = host.value;
  if (element === null) {
    return;
  }

  const result = isTouch(event)
    ? touchInput.beginPointer(event)
    : desktopInput.beginPointer(event);
  if (!result.accepted || result.pointerId === null) {
    return;
  }
  dragging.value = true;
  element.setPointerCapture(result.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (!isTouch(event)) {
    dispatchInputAction(desktopInput.movePointer(event));
    return;
  }

  const bounds = hostBounds();
  if (bounds === null) {
    return;
  }
  dispatchInputActions(touchInput.movePointer(event, bounds));
}

function onPointerUp(event: PointerEvent): void {
  if (isTouch(event)) {
    const bounds = hostBounds();
    if (bounds !== null) {
      dispatchInputActions(touchInput.endPointer(event, bounds));
    } else {
      touchInput.cancelPointer(event.pointerId);
    }
    releasePointerCapture(event.pointerId);
    dragging.value = touchInput.activePointerCount > 0;
    return;
  }

  const bounds = hostBounds();
  if (bounds !== null) {
    dispatchInputAction(desktopInput.selectionOnPointerUp(event, bounds));
  }
  finishDesktopPointer(event.pointerId);
}

function onPointerCancel(event: PointerEvent): void {
  if (isTouch(event)) {
    touchInput.cancelPointer(event.pointerId);
    releasePointerCapture(event.pointerId);
    dragging.value = touchInput.activePointerCount > 0;
    return;
  }
  finishDesktopPointer(event.pointerId);
}

function finishDesktopPointer(pointerId: number): void {
  if (!desktopInput.endPointer(pointerId)) {
    return;
  }
  releasePointerCapture(pointerId);
  dragging.value = false;
}

function releasePointerCapture(pointerId: number): void {
  const element = host.value;
  if (element?.hasPointerCapture(pointerId)) {
    element.releasePointerCapture(pointerId);
  }
}

function onWheel(event: WheelEvent): void {
  const bounds = hostBounds();
  if (bounds === null) {
    return;
  }
  dispatchInputAction(desktopInput.wheel(event, bounds));
}

function onDoubleClick(event: MouseEvent): void {
  const bounds = hostBounds();
  if (bounds === null) {
    return;
  }
  dispatchInputAction(desktopInput.activate(event, bounds));
}

function dispatchInputActions(actions: readonly ViewerInputAction[]): void {
  for (const action of actions) {
    dispatchInputAction(action);
  }
}

function dispatchInputAction(action: ViewerInputAction | null): void {
  if (action === null) {
    return;
  }

  switch (action.type) {
    case "pan":
      browser.panByScreen(action.delta);
      break;
    case "zoom":
      browser.zoomByFactorAtScreen(action.factor, action.anchor);
      break;
    case "activate-at": {
      const item = hitTestCanvasItems(snapshot.value.items, action.point);
      if (item !== null) {
        emit("activate", item.mediaId);
      }
      break;
    }
    case "select-at": {
      const item = hitTestCanvasItems(snapshot.value.items, action.point);
      if (item === null) {
        if (action.mode === "replace") {
          selection.clear();
        }
        break;
      }
      if (action.mode === "toggle") {
        selection.toggle(item.mediaId);
      } else {
        selection.replace(item.mediaId);
      }
      break;
    }
    default:
      break;
  }
}

function hostBounds(): InputBounds | null {
  const element = host.value;
  if (element === null) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top };
}

function isTouch(event: PointerEvent): boolean {
  return event.pointerType === "touch";
}

function fitContent(): void {
  if (!canFit.value) {
    return;
  }
  rendererError.value = null;
  try {
    browser.fitToContent(40);
  } catch (error) {
    rendererError.value = normalizeError(error);
  }
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as { message?: unknown };
    if (typeof candidate.message === "string") {
      return candidate.message;
    }
  }
  return String(error);
}

onMounted(async () => {
  unsubscribe = browser.subscribe((nextSnapshot) => {
    snapshot.value = nextSnapshot;
    if (renderer.initialized) {
      renderer.update(nextSnapshot);
    }
  });
  unsubscribeSelection = selection.subscribe((nextSnapshot) => {
    selectionSnapshot.value = nextSnapshot;
  });

  const element = host.value;
  if (element === null) {
    return;
  }

  resizeObserver = new ResizeObserver(scheduleViewportSync);
  resizeObserver.observe(element);
  syncViewport();

  try {
    await renderer.init(element);
    if (disposed || !renderer.initialized) {
      return;
    }
    renderer.update(snapshot.value);
  } catch (error) {
    if (!disposed) {
      rendererError.value = normalizeError(error);
    }
  }
});

onBeforeUnmount(() => {
  disposed = true;
  desktopInput.reset();
  touchInput.reset();
  unsubscribe?.();
  unsubscribeSelection?.();
  resizeObserver?.disconnect();
  if (resizeFrame !== null) {
    window.cancelAnimationFrame(resizeFrame);
  }
  renderer.destroy();
  browser.dispose();
});
</script>

<template>
  <section
    ref="host"
    class="canvas-viewport"
    :class="{ dragging }"
    aria-label="Free canvas media browser"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @wheel.prevent="onWheel"
    @dblclick="onDoubleClick"
  >
    <div
      v-for="item in selectedItems"
      :key="item.mediaId"
      class="selection-outline"
      :style="selectionStyle(item)"
      aria-hidden="true"
    />

    <div class="canvas-hud">
      <span class="zoom-label">{{ zoomLabel }}</span>
      <button
        class="fit-button"
        type="button"
        :disabled="!canFit"
        @pointerdown.stop
        @click.stop="fitContent"
      >
        Fit
      </button>
    </div>

    <div v-if="rendererError" class="canvas-error" role="alert">
      {{ rendererError }}
    </div>
  </section>
</template>

<style scoped>
.canvas-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at center, rgba(255, 255, 255, 0.025), transparent 46%),
    var(--wf-bg);
  cursor: grab;
  contain: strict;
  touch-action: none;
  user-select: none;
}

.canvas-viewport.dragging {
  cursor: grabbing;
}

.selection-outline {
  position: absolute;
  z-index: 2;
  top: 0;
  left: 0;
  border: 2px solid var(--wf-accent);
  pointer-events: none;
  contain: layout paint style;
}

.canvas-hud {
  position: absolute;
  z-index: 3;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px;
  border: 1px solid var(--wf-border);
  border-radius: 9px;
  background: rgba(21, 23, 26, 0.84);
  backdrop-filter: blur(10px);
}

.zoom-label {
  min-width: 48px;
  padding-left: 5px;
  color: var(--wf-text-muted);
  font-size: 0.72rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.fit-button {
  min-height: 26px;
  padding: 3px 8px;
  border: 1px solid var(--wf-border);
  border-radius: 6px;
  background: var(--wf-surface-raised);
  color: var(--wf-text);
  font-size: 0.72rem;
  cursor: pointer;
}

.fit-button:disabled {
  opacity: 0.4;
  cursor: default;
}

.canvas-error {
  position: absolute;
  z-index: 4;
  left: 50%;
  top: 16px;
  max-width: min(560px, calc(100% - 32px));
  transform: translateX(-50%);
  padding: 8px 12px;
  border: 1px solid rgba(239, 139, 139, 0.28);
  border-radius: 8px;
  background: rgba(95, 30, 34, 0.9);
  color: #ffd2d2;
  font-size: 0.76rem;
}
</style>
