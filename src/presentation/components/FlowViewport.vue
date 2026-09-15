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

interface PendingAppend {
  wrap: HTMLElement;
  epoch: number;
  completesLoad: boolean;
}

const selection = useMediaSelection();
const viewportElement = ref<HTMLElement | null>(null);
const imgboxElement = ref<HTMLElement | null>(null);
const snapshot = shallowRef(props.browser.snapshot);

let unsubscribeBrowser: (() => void) | null = null;
let unsubscribeSelection: (() => void) | null = null;
let displayObserver: MutationObserver | null = null;
let activeSessionId: string | null = null;
let layoutEpoch = 0;
let loading = 0;
let renderedCount = 0;
let columnElements: HTMLElement[] = [];
let columnHeights: number[] = [];
let masonryColumnWidth = 1;
let masonryFrontierHeight = 0;
let flowContentTop = 0;
let queue: LegacyFlowItem[] = [];
let queuedIds = new Set<string>();
let itemStates = new Map<string, LegacyItemState>();
let activeBatchRemaining = 0;
let activeBatchEpoch = 0;
let pendingAppends: PendingAppend[] = [];
let pendingAppendIds = new Set<string>();
let appendFrame: number | null = null;
let lastScrollAt = Number.NEGATIVE_INFINITY;
let savedFlowScrollTop = 0;
let rootScrollEnabled = false;
let destroyed = false;
let loadTimer: number | null = null;

const LEGACY_BATCH_SIZE = 25;
const LEGACY_COLUMN_COUNT = 4;
const LEGACY_COLUMN_GAP = 10;
const LEGACY_ROW_GAP = 10;
const LEGACY_JUSTIFIED_HEIGHT = 220;
const SCROLL_ACTIVE_WINDOW_MS = 90;
const APPENDS_PER_SCROLL_FRAME = 2;
const APPENDS_PER_IDLE_FRAME = 10;
const ROOT_SCROLL_CLASS = "wf-flow-root-scroll";

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
  cancelPendingAppends();
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
  cancelPendingAppends();
  layoutEpoch += 1;
  loading = 0;
  renderedCount = 0;
  activeBatchRemaining = 0;
  activeBatchEpoch = layoutEpoch;
  queue = [];
  queuedIds.clear();

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
  columnHeights = [];
  masonryFrontierHeight = 0;

  if (snapshot.value.layoutMode === "masonry") {
    imgbox.className = "legacy-imgbox masonry";
    for (let index = 0; index < LEGACY_COLUMN_COUNT; index += 1) {
      const column = document.createElement("div");
      column.className = "legacy-column";
      imgbox.appendChild(column);
      columnElements.push(column);
      columnHeights.push(0);
    }
    updateMasonryColumnWidth();
  } else {
    imgbox.className = "legacy-imgbox justified";
  }
  updateFlowContentTop();
}

function updateFlowContentTop(): void {
  const viewport = viewportElement.value;
  if (viewport === null) {
    flowContentTop = 0;
    return;
  }
  const root = document.documentElement;
  flowContentTop = viewport.getBoundingClientRect().top + root.scrollTop;
}

function updateMasonryColumnWidth(): void {
  const viewport = viewportElement.value;
  const imgbox = imgboxElement.value;
  const availableWidth = viewport?.clientWidth ?? imgbox?.clientWidth ?? 1;
  const totalGap = LEGACY_COLUMN_GAP * Math.max(0, LEGACY_COLUMN_COUNT - 1);
  masonryColumnWidth = Math.max(1, (availableWidth - totalGap) / LEGACY_COLUMN_COUNT);
}

function rebuildMasonryHeightModel(): void {
  updateFlowContentTop();
  if (snapshot.value.layoutMode !== "masonry" || columnElements.length === 0) {
    return;
  }

  updateMasonryColumnWidth();
  columnHeights = columnElements.map((column) => {
    let height = 0;
    let count = 0;
    for (const child of Array.from(column.children)) {
      const img = child.firstElementChild;
      if (!(img instanceof HTMLImageElement)) {
        continue;
      }
      if (count > 0) {
        height += LEGACY_ROW_GAP;
      }
      height += estimatedMasonryImageHeight(img);
      count += 1;
    }
    return height;
  });
  updateMasonryFrontier();
}

function estimatedMasonryImageHeight(img: HTMLImageElement): number {
  const width = Math.max(1, img.naturalWidth);
  const height = Math.max(1, img.naturalHeight);
  return masonryColumnWidth * (height / width);
}

function shortestColumnIndex(): number {
  if (columnHeights.length === 0) {
    return -1;
  }
  let shortestIndex = 0;
  let shortestHeight = columnHeights[0];
  for (let index = 1; index < columnHeights.length; index += 1) {
    if (columnHeights[index] < shortestHeight) {
      shortestHeight = columnHeights[index];
      shortestIndex = index;
    }
  }
  return shortestIndex;
}

function updateMasonryFrontier(): void {
  if (columnHeights.length === 0) {
    masonryFrontierHeight = 0;
    return;
  }
  masonryFrontierHeight = Math.min(...columnHeights);
}

function nearLoadedEnd(): boolean {
  const root = document.documentElement;
  const imgbox = imgboxElement.value;
  if (!rootScrollEnabled || imgbox === null) {
    return false;
  }
  if (renderedCount === 0) {
    return true;
  }

  const localFrontier =
    snapshot.value.layoutMode === "masonry"
      ? masonryFrontierHeight
      : imgbox.scrollHeight;
  const documentFrontier = flowContentTop + localFrontier;
  return (
    root.scrollTop + root.clientHeight >=
    documentFrontier - root.clientHeight
  );
}

function hasPendingVisualWork(): boolean {
  return loading > 0 || pendingAppends.length > 0;
}

function loadNext(): void {
  if (destroyed || !rootScrollEnabled) {
    return;
  }

  if (activeBatchRemaining === 0) {
    if (hasPendingVisualWork() || !nearLoadedEnd()) {
      return;
    }
    activeBatchRemaining = LEGACY_BATCH_SIZE;
    activeBatchEpoch = layoutEpoch;
  }

  if (activeBatchEpoch !== layoutEpoch) {
    activeBatchRemaining = 0;
    return;
  }

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
      queueAppend(state.wrap, activeBatchEpoch, false);
      continue;
    }

    if (state.status === "loading") {
      continue;
    }

    startImageLoad(state, activeBatchEpoch);
  }

  if (activeBatchRemaining === 0 && !hasPendingVisualWork()) {
    scheduleLoadNext(0);
  }
}

function finishPendingProducerBatch(): void {
  if (activeBatchRemaining === 0 || queue.length > 0) {
    return;
  }
  activeBatchRemaining = 0;
  if (!hasPendingVisualWork()) {
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
    queueAppend(wrap, epoch, true);
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

function queueAppend(
  wrap: HTMLElement,
  epoch: number,
  completesLoad: boolean,
): void {
  const mediaId = wrap.dataset.mediaId;
  if (mediaId !== undefined && pendingAppendIds.has(mediaId)) {
    return;
  }
  if (mediaId !== undefined) {
    pendingAppendIds.add(mediaId);
  }
  pendingAppends.push({ wrap, epoch, completesLoad });
  scheduleAppendFrame();
}

function scheduleAppendFrame(): void {
  if (appendFrame !== null || destroyed || pendingAppends.length === 0) {
    return;
  }
  appendFrame = window.requestAnimationFrame(flushPendingAppends);
}

function flushPendingAppends(timestamp: number): void {
  appendFrame = null;
  if (destroyed) {
    return;
  }

  const scrollActive = timestamp - lastScrollAt < SCROLL_ACTIVE_WINDOW_MS;
  const budget = scrollActive
    ? APPENDS_PER_SCROLL_FRAME
    : APPENDS_PER_IDLE_FRAME;
  let committed = 0;

  while (committed < budget && pendingAppends.length > 0) {
    const pending = pendingAppends.shift();
    if (pending === undefined) {
      break;
    }
    const mediaId = pending.wrap.dataset.mediaId;
    if (mediaId !== undefined) {
      pendingAppendIds.delete(mediaId);
    }

    if (pending.epoch !== layoutEpoch) {
      if (pending.completesLoad) {
        loading = Math.max(0, loading - 1);
      }
      continue;
    }

    appendWrap(pending.wrap);
    if (pending.completesLoad) {
      loading = Math.max(0, loading - 1);
    }
    committed += 1;
  }

  if (pendingAppends.length > 0) {
    scheduleAppendFrame();
    return;
  }

  if (loading === 0 && activeBatchRemaining === 0) {
    scheduleLoadNext(0);
  }
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
    if (columnElements.length === 0 || columnHeights.length === 0) {
      buildLayoutShell();
    }
    const targetIndex = shortestColumnIndex();
    const target = columnElements[targetIndex];
    const img = wrap.firstElementChild;
    if (targetIndex < 0 || target === undefined || !(img instanceof HTMLImageElement)) {
      return;
    }

    target.appendChild(wrap);
    const gap = columnHeights[targetIndex] > 0 ? LEGACY_ROW_GAP : 0;
    columnHeights[targetIndex] += gap + estimatedMasonryImageHeight(img);
    updateMasonryFrontier();
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

function handleDocumentScroll(): void {
  if (!rootScrollEnabled) {
    return;
  }
  lastScrollAt = performance.now();
  loadNext();
}

function handleWindowResize(): void {
  rebuildMasonryHeightModel();
  loadNext();
}

function syncRootScrollerFromVisibility(): void {
  const viewport = viewportElement.value;
  const shouldEnable = viewport !== null && viewport.style.display !== "none";
  if (shouldEnable === rootScrollEnabled) {
    return;
  }

  const root = document.documentElement;
  if (shouldEnable) {
    root.classList.add(ROOT_SCROLL_CLASS);
    document.body.classList.add(ROOT_SCROLL_CLASS);
    rootScrollEnabled = true;
    window.requestAnimationFrame(() => {
      if (!rootScrollEnabled || destroyed) {
        return;
      }
      root.scrollTop = savedFlowScrollTop;
      rebuildMasonryHeightModel();
      loadNext();
    });
    return;
  }

  savedFlowScrollTop = root.scrollTop;
  rootScrollEnabled = false;
  root.classList.remove(ROOT_SCROLL_CLASS);
  document.body.classList.remove(ROOT_SCROLL_CLASS);
  root.scrollTop = 0;
}

function disableRootScroller(): void {
  const root = document.documentElement;
  if (rootScrollEnabled) {
    savedFlowScrollTop = root.scrollTop;
  }
  rootScrollEnabled = false;
  root.classList.remove(ROOT_SCROLL_CLASS);
  document.body.classList.remove(ROOT_SCROLL_CLASS);
  root.scrollTop = 0;
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

function cancelPendingAppends(): void {
  if (appendFrame !== null) {
    window.cancelAnimationFrame(appendFrame);
    appendFrame = null;
  }
  pendingAppends = [];
  pendingAppendIds.clear();
}

function detachImageCallbacks(state: LegacyItemState): void {
  if (state.img !== null) {
    state.img.onload = null;
    state.img.onerror = null;
  }
}

function scrollToStart(): void {
  savedFlowScrollTop = 0;
  if (rootScrollEnabled) {
    document.documentElement.scrollTop = 0;
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

  document.addEventListener("scroll", handleDocumentScroll, { passive: true });
  window.addEventListener("resize", handleWindowResize, { passive: true });

  const viewport = viewportElement.value;
  if (viewport !== null) {
    displayObserver = new MutationObserver(syncRootScrollerFromVisibility);
    displayObserver.observe(viewport, {
      attributes: true,
      attributeFilter: ["style"],
    });
  }
  syncRootScrollerFromVisibility();
  loadNext();
});

onBeforeUnmount(() => {
  destroyed = true;
  layoutEpoch += 1;
  activeBatchRemaining = 0;
  unsubscribeBrowser?.();
  unsubscribeSelection?.();
  displayObserver?.disconnect();
  document.removeEventListener("scroll", handleDocumentScroll);
  window.removeEventListener("resize", handleWindowResize);
  cancelScheduledLoad();
  cancelPendingAppends();
  disableRootScroller();
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
:global(html.wf-flow-root-scroll) {
  height: auto;
  min-height: 100%;
  overflow-x: hidden;
  overflow-y: scroll;
}

:global(body.wf-flow-root-scroll) {
  height: auto;
  min-height: 100vh;
  overflow: visible;
}

:global(body.wf-flow-root-scroll #app) {
  height: auto;
  min-height: 100vh;
}

:global(body.wf-flow-root-scroll .viewer-shell) {
  height: auto !important;
  min-height: 100vh;
  display: block;
}

:global(body.wf-flow-root-scroll .viewer-toolbar) {
  position: sticky;
  top: 0;
  z-index: 20;
}

:global(body.wf-flow-root-scroll .viewer-stage) {
  min-height: calc(100vh - var(--wf-toolbar-height));
  overflow: visible !important;
}

:global(body.wf-flow-root-scroll .viewer-stage > .legacy-flow-viewport.viewer-pane) {
  position: relative !important;
  inset: auto !important;
  min-height: calc(100vh - var(--wf-toolbar-height));
}

.legacy-flow-viewport {
  position: relative;
  width: 100%;
  min-height: calc(100vh - var(--wf-toolbar-height));
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
  min-width: 0;
  cursor: pointer;
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
