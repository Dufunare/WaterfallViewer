<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import type {
  LegacyFlowBrowserController,
  LegacyFlowBrowserEvent,
  LegacyFlowItem,
} from "../../application/browser/legacyFlowBrowserController";
import {
  CanvasDomTileCache,
  type CanvasDomMediaTile,
  type CanvasDomViewRect,
} from "../canvas/canvasDomTileCache";
import { useMediaSelection } from "../selectionContext";
import { FreeformCanvasLayoutBuilder } from "../../layout/canvas/freeformCanvasLayout";

const props = defineProps<{ browser: LegacyFlowBrowserController }>();
const emit = defineEmits<{ activate: [mediaId: string] }>();
const selection = useMediaSelection();

// The outer fetch/DOM window is deliberately larger than the inner refresh
// threshold: pan/zoom frames only move one GPU-composited world transform.
const PRELOAD_MARGIN_PX = 680;
const REFRESH_GUARD_PX = 230;
const BASE_MIN_ZOOM = 0.46;
const MAX_ZOOM = 6;
const ZOOM_REFERENCE_AREA = 1920 * 1080;
const MAX_VISIBLE_ON_ZOOM_OUT = 240;
const LAYOUT_BATCH = 40;
const LAYOUT_FRAME_BUDGET_MS = 5;

interface Camera { x: number; y: number; zoom: number }
interface DragState {
  pointerId: number;
  clientX: number;
  clientY: number;
  cameraX: number;
  cameraY: number;
  moved: boolean;
}

const host = ref<HTMLElement | null>(null);
const world = ref<HTMLElement | null>(null);
const zoomLabel = ref("100%");
const renderedCount = ref(0);
const placedCount = ref(0);
const dragging = ref(false);

let camera: Camera = { x: 0, y: 0, zoom: 1 };
let dimensions = { width: 1, height: 1 };
let atlas = new FreeformCanvasLayoutBuilder();
const itemById = new Map<string, LegacyFlowItem>();
let cache: CanvasDomTileCache | null = null;
let selectedIds: ReadonlySet<string> = new Set();
let coverage: CanvasDomViewRect | null = null;
let layoutRevision = 0;
let projectedRevision = -1;
let pendingItems: LegacyFlowItem[] = [];
let pendingHead = 0;
let layoutFrame: number | null = null;
let paintFrame: number | null = null;
let cameraTouched = false;
let disposed = false;
let sessionId: string | null = null;
let unsubscribeBrowser: (() => void) | null = null;
let unsubscribeSelection: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let drag: DragState | null = null;
let suppressClick = false;
let lastWheelAt = Number.NEGATIVE_INFINITY;

function minZoomFor(viewport = dimensions): number {
  const area = Math.max(1, viewport.width * viewport.height);
  return Math.min(MAX_ZOOM, BASE_MIN_ZOOM * Math.max(1, Math.sqrt(area / ZOOM_REFERENCE_AREA)));
}

function resetCamera(): void {
  const first = atlas.firstNode;
  const worldX = first === null ? 0 : first.x + first.width / 2;
  const worldY = first === null ? 0 : first.y + first.height / 2;
  const zoom = Math.max(1, minZoomFor());
  camera = {
    x: dimensions.width / 2 - worldX * zoom,
    y: dimensions.height / 2 - worldY * zoom,
    zoom,
  };
  schedulePaint();
}

function receive(event: LegacyFlowBrowserEvent): void {
  if (event.type === "state" || disposed) return;
  if (event.type === "reset") {
    if (layoutFrame !== null) window.cancelAnimationFrame(layoutFrame);
    layoutFrame = null;
    pendingItems = [];
    pendingHead = 0;
    atlas = new FreeformCanvasLayoutBuilder();
    itemById.clear();
    cache?.clear();
    coverage = null;
    layoutRevision++;
    placedCount.value = 0;
    renderedCount.value = 0;
    if (sessionId !== event.snapshot.sessionId) {
      sessionId = event.snapshot.sessionId;
      cameraTouched = false;
      resetCamera();
    }
  }
  pendingItems.push(...event.items);
  scheduleLayout();
  schedulePaint();
}

function scheduleLayout(): void {
  if (disposed || layoutFrame !== null || pendingHead >= pendingItems.length) return;
  layoutFrame = window.requestAnimationFrame(flushLayout);
}

function validDimensions(item: LegacyFlowItem): boolean {
  return item.width !== null && item.height !== null &&
    Number.isFinite(item.width) && Number.isFinite(item.height) &&
    item.width > 0 && item.height > 0;
}

function flushLayout(): void {
  layoutFrame = null;
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
  } while (pendingHead < pendingItems.length &&
      performance.now() - started < LAYOUT_FRAME_BUDGET_MS);

  if (wasEmpty && atlas.size > 0 && !cameraTouched) resetCamera();
  placedCount.value = atlas.size;
  layoutRevision++;
  schedulePaint();

  if (pendingHead < pendingItems.length) {
    scheduleLayout();
  } else {
    pendingItems = [];
    pendingHead = 0;
  }
}

function visibleWorldRect(): CanvasDomViewRect {
  return {
    x: -camera.x / camera.zoom,
    y: -camera.y / camera.zoom,
    width: dimensions.width / camera.zoom,
    height: dimensions.height / camera.zoom,
  };
}

function inflate(rect: CanvasDomViewRect, amount: number): CanvasDomViewRect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

function contains(outer: CanvasDomViewRect, inner: CanvasDomViewRect): boolean {
  return outer.x <= inner.x && outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height;
}

function schedulePaint(): void {
  if (disposed || paintFrame !== null) return;
  paintFrame = window.requestAnimationFrame(paint);
}

function paint(): void {
  paintFrame = null;
  if (disposed) return;
  const element = world.value;
  if (element === null) return;

  const { x, y, zoom } = camera;
  element.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${zoom})`;
  const nextZoomLabel = `${Math.round(zoom * 100)}%`;
  if (zoomLabel.value !== nextZoomLabel) zoomLabel.value = nextZoomLabel;
  const view = visibleWorldRect();
  const moving = dragging.value || performance.now() - lastWheelAt < 140;
  const innerRect = inflate(view, REFRESH_GUARD_PX / zoom);

  if (coverage === null || projectedRevision !== layoutRevision ||
      !contains(coverage, innerRect)) {
    coverage = inflate(view, PRELOAD_MARGIN_PX / zoom);
    const tiles: CanvasDomMediaTile[] = atlas.query(coverage).flatMap((node) => {
      const item = itemById.get(node.mediaId);
      if (item === undefined) return [];
      return [{
        mediaId: item.mediaId,
        name: item.name,
        relativePath: item.relativePath,
        uri: item.resourceUri,
        x: node.x, y: node.y,
        width: node.width, height: node.height,
        sourceWidth: item.width, sourceHeight: item.height,
      }];
    });
    cache?.update(tiles, view, selectedIds, moving);
    renderedCount.value = cache?.activeCount ?? 0;
    projectedRevision = layoutRevision;
  } else {
    cache?.noteCamera(view, moving);
  }
}

function visibleCountAt(
  zoom: number, anchorX: number, anchorY: number, px: number, py: number,
): number {
  if (atlas.size === 0) return 0;
  const x = px - anchorX * zoom;
  const y = py - anchorY * zoom;
  return atlas.count({
    x: -x / zoom, y: -y / zoom,
    width: dimensions.width / zoom,
    height: dimensions.height / zoom,
  }, MAX_VISIBLE_ON_ZOOM_OUT + 1);
}

function zoomAt(nextZoom: number, clientX: number, clientY: number): void {
  const element = host.value;
  if (element === null) return;
  const rect = element.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const previous = camera;
  let zoom = Math.min(MAX_ZOOM, Math.max(minZoomFor(), nextZoom));
  if (zoom === previous.zoom) return;
  const anchorX = (px - previous.x) / previous.zoom;
  const anchorY = (py - previous.y) / previous.zoom;
  if (zoom < previous.zoom &&
      visibleCountAt(zoom, anchorX, anchorY, px, py) > MAX_VISIBLE_ON_ZOOM_OUT) {
    if (visibleCountAt(previous.zoom, anchorX, anchorY, px, py) > MAX_VISIBLE_ON_ZOOM_OUT) return;
    let low = zoom;
    let high = previous.zoom;
    for (let step = 0; step < 8; step++) {
      const mid = (low + high) / 2;
      if (visibleCountAt(mid, anchorX, anchorY, px, py) > MAX_VISIBLE_ON_ZOOM_OUT) low = mid;
      else high = mid;
    }
    zoom = high;
  }
  cameraTouched = true;
  camera = { x: px - anchorX * zoom, y: py - anchorY * zoom, zoom };
  schedulePaint();
}

function zoomFromCenter(factor: number): void {
  const element = host.value;
  if (element === null) return;
  const rect = element.getBoundingClientRect();
  zoomAt(camera.zoom * factor,
    rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const delta = event.deltaMode === 1 ? event.deltaY * 16 :
    event.deltaMode === 2 ? event.deltaY * dimensions.height : event.deltaY;
  lastWheelAt = performance.now();
  zoomAt(camera.zoom * Math.exp(-delta * 0.0015),
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
    cameraX: camera.x,
    cameraY: camera.y,
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
  camera = {
    x: drag.cameraX + dx,
    y: drag.cameraY + dy,
    zoom: camera.zoom,
  };
  schedulePaint();
}

function onPointerUp(event: PointerEvent): void {
  if (drag === null || drag.pointerId !== event.pointerId) return;
  suppressClick = drag.moved;
  if (host.value?.hasPointerCapture(event.pointerId)) {
    host.value.releasePointerCapture(event.pointerId);
  }
  drag = null;
  dragging.value = false;
  schedulePaint();
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
    restoreCamera();
  } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    cameraTouched = true;
    const step = 90;
    camera = {
      ...camera,
      x: camera.x + (event.key === "ArrowRight" ? -step : event.key === "ArrowLeft" ? step : 0),
      y: camera.y + (event.key === "ArrowDown" ? -step : event.key === "ArrowUp" ? step : 0),
    };
    schedulePaint();
  }
}

function onResize(width: number, height: number): void {
  if (width <= 0 || height <= 0 ||
      (width === dimensions.width && height === dimensions.height)) return;
  const before = camera;
  const worldX = (dimensions.width / 2 - before.x) / before.zoom;
  const worldY = (dimensions.height / 2 - before.y) / before.zoom;
  dimensions = { width, height };
  const zoom = Math.max(before.zoom, minZoomFor());
  camera = {
    x: width / 2 - worldX * zoom,
    y: height / 2 - worldY * zoom,
    zoom,
  };
  coverage = null;
  schedulePaint();
}

function restoreCamera(): void {
  cameraTouched = false;
  resetCamera();
}

onMounted(() => {
  disposed = false;
  const element = host.value;
  if (element === null || world.value === null) return;
  cache = new CanvasDomTileCache(world.value);
  dimensions = {
    width: Math.max(1, element.clientWidth),
    height: Math.max(1, element.clientHeight),
  };
  resetCamera();
  unsubscribeBrowser = props.browser.subscribe(receive);
  unsubscribeSelection = selection.subscribe((snapshot) => {
    selectedIds = new Set(snapshot.selectedIds);
    cache?.updateSelection(selectedIds);
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
  if (layoutFrame !== null) window.cancelAnimationFrame(layoutFrame);
  if (paintFrame !== null) window.cancelAnimationFrame(paintFrame);
  cache?.dispose();
  cache = null;
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
    <div ref="world" class="canvas-world" />
    <div class="canvas-help">拖动平移 · 滚轮缩放 · 双击预览</div>
    <div class="canvas-controls" role="group" aria-label="Canvas camera controls">
      <span class="canvas-stats">{{ renderedCount }} / {{ placedCount }}</span>
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
.canvas-world {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  transform-origin: 0 0;
  will-change: transform;
}
:deep(.canvas-media) {
  position: absolute;
  box-sizing: border-box;
  overflow: hidden;
  line-height: 0;
  cursor: pointer;
}
:deep(.canvas-media.selected) {
  outline: 2px solid var(--wf-accent);
  outline-offset: 0;
}
:deep(.canvas-media img) {
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
