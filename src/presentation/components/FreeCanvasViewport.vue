<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";

import type {
  LegacyFlowBrowserController,
  LegacyFlowBrowserEvent,
  LegacyFlowItem,
} from "../../application/browser/legacyFlowBrowserController";
import { useMediaSelection } from "../selectionContext";
import { FreeformCanvasLayoutBuilder, type FreeformCanvasNode } from "../../layout/canvas/freeformCanvasLayout";

const props = defineProps<{ browser: LegacyFlowBrowserController }>();
const emit = defineEmits<{ activate: [mediaId: string] }>();
const selection = useMediaSelection();

const OVERSCAN_PX = 120;
const BASE_MIN_ZOOM = 0.46;
const MAX_ZOOM = 6;
const ZOOM_REFERENCE_AREA = 1920 * 1080;
const MAX_VISIBLE_ON_ZOOM_OUT = 240;
const LAYOUT_BATCH = 24;
const LAYOUT_FRAME_BUDGET_MS = 6;

interface Camera { x: number; y: number; zoom: number }
interface CanvasTile { item: LegacyFlowItem; node: FreeformCanvasNode }
interface DragState {
  pointerId: number;
  clientX: number;
  clientY: number;
  cameraX: number;
  cameraY: number;
  moved: boolean;
}

const host = ref<HTMLElement | null>(null);
const dimensions = shallowRef({ width: 1, height: 1 });
const camera = shallowRef<Camera>({ x: 24, y: 24, zoom: 1 });
const revision = ref(0);
const selectedIds = shallowRef(new Set<string>());
const dragging = ref(false);
let atlas = new FreeformCanvasLayoutBuilder();
const itemById = new Map<string, LegacyFlowItem>();
let pendingItems: LegacyFlowItem[] = [];
let pendingHead = 0;
let processFrame: number | null = null;
let cameraTouched = false;
let disposed = false;
let sessionId: string | null = null;
let unsubscribeBrowser: (() => void) | null = null;
let unsubscribeSelection: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let drag: DragState | null = null;
let suppressClick = false;

function minZoomFor(viewport = dimensions.value): number {
  const area = Math.max(1, viewport.width * viewport.height);
  return Math.min(MAX_ZOOM, BASE_MIN_ZOOM * Math.max(1, Math.sqrt(area / ZOOM_REFERENCE_AREA)));
}

function resetCamera(): void {
  const first = atlas.firstNode;
  const worldX = first === null ? 0 : first.x + first.width / 2;
  const worldY = first === null ? 0 : first.y + first.height / 2;
  const zoom = Math.max(1, minZoomFor());
  camera.value = {
    x: dimensions.value.width / 2 - worldX * zoom,
    y: dimensions.value.height / 2 - worldY * zoom,
    zoom,
  };
}

function receive(event: LegacyFlowBrowserEvent): void {
  if (event.type === "state" || disposed) return;
  if (event.type === "reset") {
    if (processFrame !== null) window.cancelAnimationFrame(processFrame);
    processFrame = null;
    pendingItems = [];
    pendingHead = 0;
    atlas = new FreeformCanvasLayoutBuilder();
    itemById.clear();
    if (sessionId !== event.snapshot.sessionId) {
      sessionId = event.snapshot.sessionId;
      cameraTouched = false;
      resetCamera();
    }
    revision.value += 1;
  }
  pendingItems.push(...event.items);
  schedulePlacement();
}

function schedulePlacement(): void {
  if (disposed || processFrame !== null || pendingHead >= pendingItems.length) return;
  processFrame = window.requestAnimationFrame(flushPlacement);
}

function validDimensions(item: LegacyFlowItem): boolean {
  return item.width !== null && item.height !== null &&
    Number.isFinite(item.width) && Number.isFinite(item.height) &&
    item.width > 0 && item.height > 0;
}

function flushPlacement(): void {
  processFrame = null;
  if (disposed) return;
  const started = performance.now();
  const wasEmpty = atlas.size === 0;
  do {
    const batch = pendingItems.slice(pendingHead, pendingHead + LAYOUT_BATCH);
    if (batch.length === 0) break;
    atlas.append(batch.map((item) => ({
      mediaId: item.mediaId,
      width: validDimensions(item) ? item.width! : 1,
      height: validDimensions(item) ? item.height! : 1,
    })));
    for (const item of batch) itemById.set(item.mediaId, item);
    pendingHead += batch.length;
  } while (pendingHead < pendingItems.length && performance.now() - started < LAYOUT_FRAME_BUDGET_MS);

  if (wasEmpty && atlas.size > 0 && !cameraTouched) resetCamera();
  revision.value += 1;
  if (pendingHead < pendingItems.length) {
    schedulePlacement();
  } else {
    pendingItems = [];
    pendingHead = 0;
  }
}

const visibleTiles = computed<CanvasTile[]>(() => {
  void revision.value;
  if (atlas.size === 0) return [];
  const { x, y, zoom } = camera.value;
  const { width, height } = dimensions.value;
  return atlas.query({
    x: (-x - OVERSCAN_PX) / zoom,
    y: (-y - OVERSCAN_PX) / zoom,
    width: (width + OVERSCAN_PX * 2) / zoom,
    height: (height + OVERSCAN_PX * 2) / zoom,
  }).flatMap((node) => {
    const item = itemById.get(node.mediaId);
    return item === undefined ? [] : [{ item, node }];
  });
});

const cameraTransform = computed(() => {
  const { x, y, zoom } = camera.value;
  return `translate3d(${x}px, ${y}px, 0) scale(${zoom})`;
});
const zoomLabel = computed(() => `${Math.round(camera.value.zoom * 100)}%`);
const gridStyle = computed(() => ({
  backgroundSize: `${24 * camera.value.zoom}px ${24 * camera.value.zoom}px`,
  backgroundPosition: `${camera.value.x}px ${camera.value.y}px`,
}));

function visibleCountAt(zoom: number, worldX: number, worldY: number, px: number, py: number): number {
  if (atlas.size === 0) return 0;
  const x = px - worldX * zoom;
  const y = py - worldY * zoom;
  return atlas.query({
    x: -x / zoom,
    y: -y / zoom,
    width: dimensions.value.width / zoom,
    height: dimensions.value.height / zoom,
  }).length;
}

function zoomAt(nextZoom: number, clientX: number, clientY: number): void {
  const element = host.value;
  if (element === null) return;
  const rect = element.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const previous = camera.value;
  let zoom = Math.min(MAX_ZOOM, Math.max(minZoomFor(), nextZoom));
  if (zoom === previous.zoom) return;
  const anchorX = (px - previous.x) / previous.zoom;
  const anchorY = (py - previous.y) / previous.zoom;
  if (zoom < previous.zoom &&
      visibleCountAt(zoom, anchorX, anchorY, px, py) > MAX_VISIBLE_ON_ZOOM_OUT) {
    if (visibleCountAt(previous.zoom, anchorX, anchorY, px, py) > MAX_VISIBLE_ON_ZOOM_OUT) return;
    let low = zoom;
    let high = previous.zoom;
    for (let step = 0; step < 9; step++) {
      const mid = (low + high) / 2;
      if (visibleCountAt(mid, anchorX, anchorY, px, py) > MAX_VISIBLE_ON_ZOOM_OUT) low = mid;
      else high = mid;
    }
    zoom = high;
  }
  cameraTouched = true;
  camera.value = { x: px - anchorX * zoom, y: py - anchorY * zoom, zoom };
}

function zoomFromCenter(factor: number): void {
  const element = host.value;
  if (element === null) return;
  const rect = element.getBoundingClientRect();
  zoomAt(camera.value.zoom * factor,
    rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const delta = event.deltaMode === 1 ? event.deltaY * 16 :
    event.deltaMode === 2 ? event.deltaY * dimensions.value.height : event.deltaY;
  zoomAt(camera.value.zoom * Math.exp(-delta * 0.0015),
    event.clientX, event.clientY);
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 && event.button !== 1) return;
  if (event.target instanceof Element &&
      event.target.closest(".canvas-controls")) return;
  suppressClick = false;
  drag = {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    cameraX: camera.value.x,
    cameraY: camera.value.y,
    moved: false,
  };
}

function onPointerMove(event: PointerEvent): void {
  if (drag === null || drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.clientX;
  const dy = event.clientY - drag.clientY;
  if (!drag.moved && dx * dx + dy * dy > 25) {
    drag.moved = true;
    host.value?.setPointerCapture(event.pointerId);
    dragging.value = true;
  }
  if (!drag.moved) return;
  cameraTouched = true;
  camera.value = {
    x: drag.cameraX + dx,
    y: drag.cameraY + dy,
    zoom: camera.value.zoom,
  };
}

function onPointerUp(event: PointerEvent): void {
  if (drag === null || drag.pointerId !== event.pointerId) return;
  suppressClick = drag.moved;
  if (host.value?.hasPointerCapture(event.pointerId)) {
    host.value.releasePointerCapture(event.pointerId);
  }
  drag = null;
  dragging.value = false;
}

function mediaIdFromEvent(event: Event): string | null {
  if (!(event.target instanceof Element)) return null;
  const tile = event.target.closest<HTMLElement>("[data-canvas-media-id]");
  if (tile === null || !host.value?.contains(tile)) return null;
  return tile.dataset.canvasMediaId ?? null;
}

function onClick(event: MouseEvent): void {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const mediaId = mediaIdFromEvent(event);
  if (mediaId === null) return;
  if (event.ctrlKey || event.metaKey) selection.toggle(mediaId);
  else selection.replace(mediaId);
}

function onDoubleClick(event: MouseEvent): void {
  if (suppressClick) return;
  const mediaId = mediaIdFromEvent(event);
  if (mediaId !== null) emit("activate", mediaId);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.target instanceof HTMLButtonElement) return;
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoomFromCenter(1.25);
  } else if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    zoomFromCenter(0.8);
  } else if (event.key === "0") {
    event.preventDefault();
    cameraTouched = false;
    resetCamera();
  } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    cameraTouched = true;
    const step = 90;
    camera.value = {
      ...camera.value,
      x: camera.value.x + (event.key === "ArrowRight" ? -step : event.key === "ArrowLeft" ? step : 0),
      y: camera.value.y + (event.key === "ArrowDown" ? -step : event.key === "ArrowUp" ? step : 0),
    };
  }
}

function onResize(width: number, height: number): void {
  if (width <= 0 || height <= 0) return;
  const previous = dimensions.value;
  const before = camera.value;
  const worldX = (previous.width / 2 - before.x) / before.zoom;
  const worldY = (previous.height / 2 - before.y) / before.zoom;
  const viewport = { width, height };
  const zoom = Math.max(before.zoom, minZoomFor(viewport));
  dimensions.value = viewport;
  camera.value = {
    x: width / 2 - worldX * zoom,
    y: height / 2 - worldY * zoom,
    zoom,
  };
}

function restoreCamera(): void {
  cameraTouched = false;
  resetCamera();
}

onMounted(() => {
  disposed = false;
  const element = host.value;
  if (element === null) return;
  dimensions.value = {
    width: Math.max(1, element.clientWidth),
    height: Math.max(1, element.clientHeight),
  };
  resetCamera();
  unsubscribeBrowser = props.browser.subscribe(receive);
  unsubscribeSelection = selection.subscribe((snapshot) => {
    selectedIds.value = new Set(snapshot.selectedIds);
  });
  resizeObserver = new ResizeObserver(([entry]) => {
    if (entry !== undefined) onResize(entry.contentRect.width, entry.contentRect.height);
  });
  resizeObserver.observe(element);
  element.addEventListener("wheel", onWheel, { passive: false });
});

onBeforeUnmount(() => {
  disposed = true;
  unsubscribeBrowser?.();
  unsubscribeSelection?.();
  resizeObserver?.disconnect();
  host.value?.removeEventListener("wheel", onWheel);
  if (processFrame !== null) window.cancelAnimationFrame(processFrame);
  processFrame = null;
  pendingItems = [];
  itemById.clear();
});
</script>

<template>
  <section
    ref="host"
    class="free-canvas-viewport"
    :class="{ dragging }"
    role="region"
    aria-label="Free canvas media browser"
    tabindex="0"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @click="onClick"
    @dblclick="onDoubleClick"
    @keydown="onKeydown"
  >
    <div class="canvas-grid" aria-hidden="true" :style="gridStyle" />
    <div class="canvas-world" :style="{ transform: cameraTransform }">
      <div
        v-for="tile in visibleTiles"
        :key="tile.item.mediaId"
        class="canvas-media"
        :class="{ selected: selectedIds.has(tile.item.mediaId) }"
        :data-canvas-media-id="tile.item.mediaId"
        :style="{ left: `${tile.node.x}px`, top: `${tile.node.y}px`, width: `${tile.node.width}px`, height: `${tile.node.height}px` }"
        :title="tile.item.relativePath"
      >
        <img
          :src="tile.item.resourceUri"
          :alt="tile.item.name"
          draggable="false"
          decoding="async"
          loading="lazy"
        />
      </div>
    </div>
    <div class="canvas-help">拖动平移 · 滚轮缩放 · 双击预览</div>
    <div class="canvas-controls" role="group" aria-label="Canvas camera controls">
      <span class="canvas-stats">{{ visibleTiles.length }} / {{ atlas.size }}</span>
      <button type="button" title="缩小" aria-label="Zoom out" @click.stop="zoomFromCenter(0.8)">−</button>
      <output aria-label="Canvas zoom">{{ zoomLabel }}</output>
      <button type="button" title="放大" aria-label="Zoom in" @click.stop="zoomFromCenter(1.25)">+</button>
      <button type="button" title="复位视角" aria-label="Reset view" @click.stop="restoreCamera">复位</button>
    </div>
  </section>
</template>

<style scoped>
.free-canvas-viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
  touch-action: none;
  user-select: none;
  cursor: grab;
  background: var(--wf-bg);
  outline: none;
  contain: strict;
}
.free-canvas-viewport.dragging { cursor: grabbing; }
.canvas-grid {
  position: absolute;
  inset: -1px;
  pointer-events: none;
  opacity: 0.24;
  background-image: radial-gradient(circle, var(--wf-border) 1px, transparent 1.5px);
  background-size: 24px 24px;
}
.canvas-world {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  transform-origin: 0 0;
  will-change: transform;
}
.canvas-media {
  position: absolute;
  box-sizing: border-box;
  overflow: hidden;
  line-height: 0;
  cursor: pointer;
}
.canvas-media.selected { outline: 2px solid var(--wf-accent); outline-offset: 3px; }
.canvas-media img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  -webkit-user-drag: none;
}
.canvas-help, .canvas-controls {
  position: absolute;
  bottom: 15px;
  z-index: 10;
  padding: 7px 11px;
  border: 1px solid var(--wf-border);
  border-radius: 9px;
  background: var(--wf-surface);
  color: var(--wf-text-muted);
  font-size: 12px;
}
.canvas-help { left: 15px; pointer-events: none; }
.canvas-controls { right: 15px; display: flex; gap: 8px; align-items: center; }
.canvas-controls button {
  cursor: pointer;
  border: 1px solid var(--wf-border);
  border-radius: 6px;
  padding: 3px 8px;
  color: var(--wf-text);
  background: var(--wf-surface-raised);
}
.canvas-controls output { min-width: 48px; text-align: center; color: var(--wf-text); }
.canvas-stats { margin-right: 7px; }
</style>
