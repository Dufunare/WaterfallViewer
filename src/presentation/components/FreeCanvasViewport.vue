<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";

import type {
  LegacyFlowBrowserController,
  LegacyFlowBrowserEvent,
  LegacyFlowItem,
} from "../../application/browser/legacyFlowBrowserController";
import { useMediaSelection } from "../selectionContext";

const props = defineProps<{ browser: LegacyFlowBrowserController }>();
const emit = defineEmits<{ activate: [mediaId: string] }>();
const selection = useMediaSelection();

const TILE_WIDTH = 310;
const TILE_HEIGHT = 242;
const TILE_STEP_X = 332;
const TILE_STEP_Y = 264;
const ATLAS_COLUMNS = 8;
const OVERSCAN_TILES = 2;
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 6;

interface Camera { x: number; y: number; zoom: number }
interface CanvasTile { item: LegacyFlowItem; x: number; y: number }
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
const items: LegacyFlowItem[] = [];
let sessionId: string | null = null;
let unsubscribeBrowser: (() => void) | null = null;
let unsubscribeSelection: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let drag: DragState | null = null;
let suppressClick = false;

function resetCamera(): void {
  camera.value = { x: 24, y: 24, zoom: 1 };
}

function receive(event: LegacyFlowBrowserEvent): void {
  if (event.type === "state") return;
  if (event.type === "reset") {
    items.length = 0;
    items.push(...event.items);
    if (sessionId !== event.snapshot.sessionId) {
      sessionId = event.snapshot.sessionId;
      resetCamera();
    }
  } else {
    items.push(...event.items);
  }
  revision.value += 1;
}

const visibleTiles = computed<CanvasTile[]>(() => {
  void revision.value;
  const count = items.length;
  if (count === 0) return [];

  const { x, y, zoom } = camera.value;
  const { width, height } = dimensions.value;
  const firstCol = Math.max(0, Math.floor(-x / zoom / TILE_STEP_X) - OVERSCAN_TILES);
  const lastCol = Math.min(ATLAS_COLUMNS - 1,
    Math.ceil((width - x) / zoom / TILE_STEP_X) + OVERSCAN_TILES);
  const firstRow = Math.max(0, Math.floor(-y / zoom / TILE_STEP_Y) - OVERSCAN_TILES);
  const lastRow = Math.min(Math.ceil(count / ATLAS_COLUMNS) - 1,
    Math.ceil((height - y) / zoom / TILE_STEP_Y) + OVERSCAN_TILES);

  const result: CanvasTile[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = firstCol; col <= lastCol; col += 1) {
      const index = row * ATLAS_COLUMNS + col;
      if (index >= count) continue;
      result.push({ item: items[index], x: col * TILE_STEP_X, y: row * TILE_STEP_Y });
    }
  }
  return result;
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

function zoomAt(nextZoom: number, clientX: number, clientY: number): void {
  const element = host.value;
  if (element === null) return;
  const rect = element.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const previous = camera.value;
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  if (zoom === previous.zoom) return;
  const anchorX = (px - previous.x) / previous.zoom;
  const anchorY = (py - previous.y) / previous.zoom;
  camera.value = {
    x: px - anchorX * zoom,
    y: py - anchorY * zoom,
    zoom,
  };
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
    resetCamera();
  } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    const step = 90;
    camera.value = {
      ...camera.value,
      x: camera.value.x + (event.key === "ArrowRight" ? -step : event.key === "ArrowLeft" ? step : 0),
      y: camera.value.y + (event.key === "ArrowDown" ? -step : event.key === "ArrowUp" ? step : 0),
    };
  }
}

onMounted(() => {
  unsubscribeBrowser = props.browser.subscribe(receive);
  unsubscribeSelection = selection.subscribe((snapshot) => {
    selectedIds.value = new Set(snapshot.selectedIds);
  });
  const element = host.value;
  if (element === null) return;
  resizeObserver = new ResizeObserver(([entry]) => {
    if (entry === undefined) return;
    dimensions.value = {
      width: entry.contentRect.width,
      height: entry.contentRect.height,
    };
  });
  resizeObserver.observe(element);
  element.addEventListener("wheel", onWheel, { passive: false });
  dimensions.value = { width: element.clientWidth, height: element.clientHeight };
});

onBeforeUnmount(() => {
  unsubscribeBrowser?.();
  unsubscribeSelection?.();
  resizeObserver?.disconnect();
  host.value?.removeEventListener("wheel", onWheel);
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
        :style="{ left: `${tile.x}px`, top: `${tile.y}px` }"
        :title="tile.item.relativePath"
      >
        <img
          :src="tile.item.resourceUri"
          :alt="tile.item.name"
          draggable="false"
          decoding="async"
        />
        <span class="canvas-media-name">{{ tile.item.name }}</span>
      </div>
    </div>
    <div class="canvas-help">拖动平移 · 滚轮缩放 · 双击预览</div>
    <div class="canvas-controls" role="group" aria-label="Canvas camera controls">
      <span class="canvas-stats">{{ visibleTiles.length }} / {{ items.length }}</span>
      <button type="button" title="缩小" aria-label="Zoom out" @click.stop="zoomFromCenter(0.8)">−</button>
      <output aria-label="Canvas zoom">{{ zoomLabel }}</output>
      <button type="button" title="放大" aria-label="Zoom in" @click.stop="zoomFromCenter(1.25)">+</button>
      <button type="button" title="复位视角" aria-label="Reset view" @click.stop="resetCamera">复位</button>
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
}
.free-canvas-viewport.dragging { cursor: grabbing; }
.canvas-grid {
  position: absolute;
  inset: -1px;
  pointer-events: none;
  opacity: 0.42;
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
  width: 310px;
  height: 242px;
  box-sizing: border-box;
  padding: 10px;
  border: 1px solid var(--wf-border);
  border-radius: 10px;
  background: var(--wf-surface);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.canvas-media.selected { outline: 2px solid var(--wf-accent); outline-offset: 1px; }
.canvas-media img {
  display: block;
  min-height: 0;
  min-width: 0;
  width: 100%;
  flex: 1 1 auto;
  object-fit: contain;
  pointer-events: none;
  -webkit-user-drag: none;
}
.canvas-media-name {
  font-size: 12px;
  color: var(--wf-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 0 0 auto;
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
