<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";

import type {
  LegacyFlowBrowserController,
  LegacyFlowBrowserEvent,
  LegacyFlowItem,
} from "../../application/browser/legacyFlowBrowserController";
import { useMediaSelection } from "../selectionContext";

const props = defineProps<{
  browser: LegacyFlowBrowserController;
}>();
const emit = defineEmits<{
  activate: [mediaId: string];
}>();

interface LegacyItemState {
  item: LegacyFlowItem;
  img: HTMLImageElement | null;
  wrap: HTMLElement | null;
  status: "idle" | "loading" | "ready";
  loadEpoch: number;
}

const selection = useMediaSelection();
const viewportElement = ref<HTMLElement | null>(null);
const imgboxElement = ref<HTMLElement | null>(null);
const snapshot = shallowRef(props.browser.snapshot);

let unsubscribeBrowser: (() => void) | null = null;
let unsubscribeSelection: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let activeSessionId: string | null = null;
let layoutEpoch = 0;
let loading = 0;
let renderedCount = 0;
let columnElements: HTMLElement[] = [];
let minColumn: HTMLElement | null = null;
let queue: LegacyFlowItem[] = [];
let queuedIds = new Set<string>();
let itemStates = new Map<string, LegacyItemState>();
let activeBatchRemaining = 0;
let activeBatchEpoch = 0;
let destroyed = false;
let loadTimer: number | null = null;

const LEGACY_BATCH_SIZE = 25;
const LEGACY_COLUMN_COUNT = 4;
const LEGACY_COLUMN_GAP = 10;
const LEGACY_ROW_GAP = 10;
const LEGACY_JUSTIFIED_HEIGHT = 220;

function handleBrowserEvent(event: LegacyFlowBrowserEvent): void {
  snapshot.value = event.snapshot;

  if (event.type === "state") {
    if (isTerminalScanState(event.snapshot.scanState?.status)) {
      finishPendingProducerBatch();
    }
    return;
  }

  if (event.type === "append") {
    appendNewQueueItems(event.items);
    loadNext();
    return;
  }

  if (event.snapshot.sessionId !== activeSessionId) {
    hardReset(event.snapshot.sessionId, event.items);
  } else {
    softReflow(event.items);
  }
}

function hardReset(
  sessionId: string | null,
  items: readonly LegacyFlowItem[],
): void {
  cancelScheduledLoad();
  layoutEpoch += 1;
  loading = 0;
  renderedCount = 0;
  activeBatchRemaining = 0;
  activeBatchEpoch = layoutEpoch;
  activeSessionId = sessionId;
  queue = [];
  queuedIds.clear();

  for (const state of itemStates.values()) {
    detachImageCallbacks(state);
  }
  itemStates.clear();

  buildLayoutShell();
  scrollToStart();
  appendNewQueueItems(items);
  loadNext();
}

function softReflow(items: readonly LegacyFlowItem[]): void {
  cancelScheduledLoad();
  layoutEpoch += 1;
  loading = 0;
  renderedCount = 0;
  activeBatchRemaining = 0;
  activeBatchEpoch = layoutEpoch;
  queue = [];
  queuedIds.clear();

  // Preserve completed Image/wrapper nodes across sort/filter/layout changes.
  // This mirrors the supplied frontend's allData.{img,wrap} reuse.
  for (const state of itemStates.values()) {
    if (state.status === "loading") {
      detachImageCallbacks(state);
      state.status = "idle";
      state.img = null;
      state.loadEpoch = layoutEpoch;
    }
  }

  buildLayoutShell();
  scrollToStart();
  for (const item of items) {
    const existing = itemStates.get(item.mediaId);
    if (existing !== undefined) {
      existing.item = item;
    }
    queue.push(item);
    queuedIds.add(item.mediaId);
  }
  loadNext();
}

function appendNewQueueItems(items: readonly LegacyFlowItem[]): void {
  for (const item of items) {
    const state = itemStates.get(item.mediaId);
    if (state !== undefined) {
      state.item = item;
      continue;
    }
    if (queuedIds.has(item.mediaId)) {
      continue;
    }
    queue.push(item);
    queuedIds.add(item.mediaId);
  }
}

function buildLayoutShell(): void {
  const imgbox = imgboxElement.value;
  if (imgbox === null) {
    return;
  }

  imgbox.replaceChildren();
  columnElements = [];
  minColumn = imgbox;

  if (snapshot.value.layoutMode === "masonry") {
    imgbox.className = "legacy-imgbox masonry";
    for (let index = 0; index < LEGACY_COLUMN_COUNT; index += 1) {
      const column = document.createElement("div");
      column.className = "legacy-column";
      imgbox.appendChild(column);
      columnElements.push(column);
    }
    minColumn = columnElements[0] ?? imgbox;
  } else {
    imgbox.className = "legacy-imgbox justified";
  }
}

function shortestColumn(): HTMLElement | null {
  if (columnElements.length === 0) {
    return null;
  }
  return columnElements.reduce((shortest, column) =>
    shortest.offsetHeight <= column.offsetHeight ? shortest : column,
  );
}

function nearLoadedEnd(): boolean {
  const viewport = viewportElement.value;
  const reference = minColumn ?? imgboxElement.value;
  if (viewport === null || reference === null) {
    return false;
  }
  if (renderedCount === 0) {
    return true;
  }

  // Keep scroll work equivalent to the legacy page: one frontier read only.
  // The shortest-column scan happens when an image is appended, never while
  // native scrolling is in progress.
  return (
    viewport.scrollTop + viewport.clientHeight >=
    reference.scrollHeight - viewport.clientHeight
  );
}

function loadNext(): void {
  if (destroyed) {
    return;
  }

  if (activeBatchRemaining === 0) {
    if (loading > 0 || !nearLoadedEnd()) {
      return;
    }
    activeBatchRemaining = LEGACY_BATCH_SIZE;
    activeBatchEpoch = layoutEpoch;
  }

  if (activeBatchEpoch !== layoutEpoch) {
    activeBatchRemaining = 0;
    return;
  }

  // The supplied frontend awaits Queue.shift() inside a 25-iteration loop.
  // Preserve that producer/consumer behavior without an unresolved Promise:
  // when discovery temporarily runs dry, keep the current batch open. Later
  // append events continue filling the same batch even while earlier images
  // from it are still loading.
  while (activeBatchRemaining > 0 && queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) {
      break;
    }
    queuedIds.delete(item.mediaId);
    activeBatchRemaining -= 1;

    let state = itemStates.get(item.mediaId);
    if (state === undefined) {
      state = {
        item,
        img: null,
        wrap: null,
        status: "idle",
        loadEpoch: activeBatchEpoch,
      };
      itemStates.set(item.mediaId, state);
    } else {
      state.item = item;
    }

    if (state.status === "ready" && state.wrap !== null) {
      appendWrap(state.wrap);
      continue;
    }

    if (state.status === "loading") {
      continue;
    }

    startImageLoad(state, activeBatchEpoch);
  }

  if (activeBatchRemaining === 0 && loading === 0) {
    scheduleLoadNext(0);
  }
}

function finishPendingProducerBatch(): void {
  if (activeBatchRemaining === 0 || queue.length > 0) {
    return;
  }
  activeBatchRemaining = 0;
  if (loading === 0) {
    scheduleLoadNext(0);
  }
}

function startImageLoad(state: LegacyItemState, epoch: number): void {
  const img = new Image();
  state.img = img;
  state.status = "loading";
  state.loadEpoch = epoch;

  img.alt = state.item.name;
  img.draggable = false;
  img.className = "legacy-image";
  img.dataset.mediaId = state.item.mediaId;

  loading += 1;
  let completed = false;
  const onComplete = () => {
    if (completed || destroyed) {
      return;
    }
    completed = true;
    img.onload = null;
    img.onerror = null;

    if (state.loadEpoch !== layoutEpoch || epoch !== layoutEpoch) {
      return;
    }

    const wrap = createWrap(state, img);
    state.wrap = wrap;
    state.status = "ready";
    appendWrap(wrap);

    loading = Math.max(0, loading - 1);
    if (loading === 0 && activeBatchRemaining === 0) {
      loadNext();
    }
  };

  img.onload = onComplete;
  img.onerror = onComplete;
  img.src = state.item.resourceUri;
}

function createWrap(state: LegacyItemState, img: HTMLImageElement): HTMLElement {
  const wrap = document.createElement("figure");
  wrap.className = "legacy-wrap";
  wrap.dataset.mediaId = state.item.mediaId;
  wrap.title = `${state.item.relativePath} — click to select, double-click to open`;
  wrap.appendChild(img);
  applySelectionClass(wrap, state.item.mediaId);
  return wrap;
}

function appendWrap(wrap: HTMLElement): void {
  const imgbox = imgboxElement.value;
  if (imgbox === null) {
    return;
  }

  renderedCount += 1;
  wrap.id = `legacy-img-${renderedCount}`;
  wrap.style.removeProperty("flex-basis");
  wrap.style.removeProperty("flex-grow");

  if (snapshot.value.layoutMode === "masonry") {
    if (columnElements.length === 0) {
      buildLayoutShell();
    }
    // Match the original loadImg(): remember the column selected immediately
    // before append. Do not rescan after append; scroll-time loadNext() reuses
    // this reference and therefore avoids four synchronous offsetHeight reads.
    minColumn = shortestColumn();
    if (minColumn === null) {
      return;
    }
    minColumn.appendChild(wrap);
    return;
  }

  const img = wrap.firstElementChild;
  if (img instanceof HTMLImageElement) {
    const width = Math.max(1, img.naturalWidth);
    const height = Math.max(1, img.naturalHeight);
    const ratio = width / height;
    wrap.style.flexBasis = `${ratio * LEGACY_JUSTIFIED_HEIGHT}px`;
    wrap.style.flexGrow = String(ratio);
  }
  imgbox.appendChild(wrap);
  minColumn = imgbox;
}

function mediaIdFromEvent(event: Event): string | null {
  const target = event.target;
  if (!(target instanceof Element)) {
    return null;
  }
  const wrap = target.closest<HTMLElement>(".legacy-wrap[data-media-id]");
  if (wrap === null || !imgboxElement.value?.contains(wrap)) {
    return null;
  }
  return wrap.dataset.mediaId ?? null;
}

function handleMediaClick(event: MouseEvent): void {
  const mediaId = mediaIdFromEvent(event);
  if (mediaId === null) {
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    selection.toggle(mediaId);
  } else {
    selection.replace(mediaId);
  }
}

function handleMediaDoubleClick(event: MouseEvent): void {
  const mediaId = mediaIdFromEvent(event);
  if (mediaId !== null) {
    emit("activate", mediaId);
  }
}

function refreshSelectionClasses(): void {
  for (const [mediaId, state] of itemStates) {
    if (state.wrap !== null) {
      applySelectionClass(state.wrap, mediaId);
    }
  }
}

function applySelectionClass(wrap: HTMLElement, mediaId: string): void {
  wrap.classList.toggle(
    "selected",
    selection.snapshot.selectedIds.includes(mediaId),
  );
}

function handleScroll(): void {
  loadNext();
}

function handleResize(): void {
  loadNext();
}

function scheduleLoadNext(delay: number): void {
  if (loadTimer !== null || destroyed) {
    return;
  }
  loadTimer = window.setTimeout(() => {
    loadTimer = null;
    loadNext();
  }, delay);
}

function cancelScheduledLoad(): void {
  if (loadTimer !== null) {
    window.clearTimeout(loadTimer);
    loadTimer = null;
  }
}

function detachImageCallbacks(state: LegacyItemState): void {
  if (state.img !== null) {
    state.img.onload = null;
    state.img.onerror = null;
  }
}

function scrollToStart(): void {
  const viewport = viewportElement.value;
  if (viewport !== null) {
    viewport.scrollTop = 0;
  }
}

function isTerminalScanState(status: string | undefined): boolean {
  return status === "finished" || status === "cancelled" || status === "failed";
}

onMounted(() => {
  destroyed = false;
  buildLayoutShell();
  unsubscribeBrowser = props.browser.subscribe(handleBrowserEvent);
  unsubscribeSelection = selection.subscribe(refreshSelectionClasses);

  const viewport = viewportElement.value;
  if (viewport !== null) {
    resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(viewport);
  }
  loadNext();
});

onBeforeUnmount(() => {
  destroyed = true;
  layoutEpoch += 1;
  activeBatchRemaining = 0;
  unsubscribeBrowser?.();
  unsubscribeSelection?.();
  resizeObserver?.disconnect();
  cancelScheduledLoad();
  for (const state of itemStates.values()) {
    detachImageCallbacks(state);
  }
});
</script>

<template>
  <section
    ref="viewportElement"
    class="legacy-flow-viewport"
    aria-label="Flow media browser"
    @scroll.passive="handleScroll"
  >
    <div
      ref="imgboxElement"
      class="legacy-imgbox masonry"
      @click="handleMediaClick"
      @dblclick="handleMediaDoubleClick"
    />
  </section>
</template>

<style scoped>
.legacy-flow-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  contain: layout paint style;
}

.legacy-imgbox.masonry {
  display: flex;
  align-items: flex-start;
  gap: v-bind('LEGACY_COLUMN_GAP + "px"');
  width: 100%;
  box-sizing: border-box;
}

.legacy-column {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: v-bind('LEGACY_ROW_GAP + "px"');
}

.legacy-imgbox.justified {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: v-bind('LEGACY_ROW_GAP + "px"') v-bind('LEGACY_COLUMN_GAP + "px"');
  width: 100%;
}

:deep(.legacy-wrap) {
  position: relative;
  margin: 0;
  overflow: hidden;
  min-width: 0;
  background: var(--wf-surface-raised);
  contain: layout paint style;
}

:deep(.legacy-wrap.selected) {
  box-shadow: inset 0 0 0 2px var(--wf-accent);
}

.legacy-imgbox.masonry :deep(.legacy-wrap) {
  width: 100%;
  flex: 0 0 auto;
}

.legacy-imgbox.justified :deep(.legacy-wrap) {
  height: v-bind('LEGACY_JUSTIFIED_HEIGHT + "px"');
  min-width: 0;
}

:deep(.legacy-image) {
  display: block;
  width: 100%;
  height: auto;
  user-select: none;
  -webkit-user-drag: none;
}

.legacy-imgbox.justified :deep(.legacy-image) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
