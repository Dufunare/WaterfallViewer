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
import { PixiCanvasRenderer } from "../../renderers/pixi/pixiCanvasRenderer";

const props = defineProps<{
  createBrowser: () => CanvasBrowserController;
}>();
const emit = defineEmits<{
  activate: [mediaId: string];
}>();

const host = ref<HTMLElement | null>(null);
const browser = markRaw(props.createBrowser());
const renderer = markRaw(new PixiCanvasRenderer());
const snapshot = shallowRef<CanvasBrowserSnapshot>(browser.snapshot);
const rendererError = ref<string | null>(null);
const dragging = ref(false);

let unsubscribe: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeFrame: number | null = null;
let activePointerId: number | null = null;
let lastPointerX = 0;
let lastPointerY = 0;
let disposed = false;

const zoomLabel = computed(() => `${Math.round(snapshot.value.camera.zoom * 100)}%`);
const canFit = computed(() => snapshot.value.itemCount > 0);

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
  if (event.button !== 0 && event.button !== 1) {
    return;
  }
  const element = host.value;
  if (element === null) {
    return;
  }

  event.preventDefault();
  activePointerId = event.pointerId;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  dragging.value = true;
  element.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (activePointerId !== event.pointerId) {
    return;
  }

  const deltaX = event.clientX - lastPointerX;
  const deltaY = event.clientY - lastPointerY;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  if (deltaX !== 0 || deltaY !== 0) {
    browser.panByScreen({ x: deltaX, y: deltaY });
  }
}

function endPointer(event: PointerEvent): void {
  if (activePointerId !== event.pointerId) {
    return;
  }

  const element = host.value;
  if (element?.hasPointerCapture(event.pointerId)) {
    element.releasePointerCapture(event.pointerId);
  }
  activePointerId = null;
  dragging.value = false;
}

function onWheel(event: WheelEvent): void {
  const element = host.value;
  if (element === null) {
    return;
  }

  const rect = element.getBoundingClientRect();
  const exponent = Math.max(-2, Math.min(2, -event.deltaY * 0.0015));
  browser.zoomByFactorAtScreen(Math.exp(exponent), {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  });
}

function onDoubleClick(event: MouseEvent): void {
  const element = host.value;
  if (element === null) {
    return;
  }
  const rect = element.getBoundingClientRect();
  const item = hitTestCanvasItems(snapshot.value.items, {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  });
  if (item !== null) {
    emit("activate", item.mediaId);
  }
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
  unsubscribe?.();
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
    @pointerup="endPointer"
    @pointercancel="endPointer"
    @wheel.prevent="onWheel"
    @dblclick="onDoubleClick"
  >
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
  user-select: none;
}

.canvas-viewport.dragging {
  cursor: grabbing;
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
