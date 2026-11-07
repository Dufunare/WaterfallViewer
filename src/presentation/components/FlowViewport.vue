<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

import type {
  LegacyFlowBrowserController,
  LegacyFlowBrowserEvent,
  LegacyFlowItem,
} from "../../application/browser/legacyFlowBrowserController";
import { useMediaSelection } from "../selectionContext";

const props = defineProps<{
  browser: LegacyFlowBrowserController;
  trackCount: number;
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
let laneElements: HTMLElement[] = [];
let laneWidths: number[] = [];
let horizontalLaneHeight = 1;
let horizontalFrontierWidth = 0;
let knownItems: LegacyFlowItem[] = [];
let flowContentTop = 0;
let queue: LegacyFlowItem[] = [];
let queueHead = 0;
let queuedIds = new Set<string>();
let itemStates = new Map<string, LegacyItemState>();
let activeBatchRemaining = 0;
let activeBatchEpoch = 0;
let pendingAppends: PendingAppend[] = [];
let pendingAppendIds = new Set<string>();
let appendFrame: number | null = null;
let lastScrollAt = Number.NEGATIVE_INFINITY;
let savedFlowScrollTop = 0;
let savedHorizontalScrollLeft = 0;
let flowVisible = false;
let rootScrollEnabled = false;
let destroyed = false;
let loadTimer: number | null = null;

const LEGACY_BATCH_SIZE = 25;
const LEGACY_COLUMN_GAP = 12;
const LEGACY_ROW_GAP = 12;
const LEGACY_EDGE_GAP = 14;
const MIN_TRACK_COUNT = 1;
const MAX_TRACK_COUNT = 32;
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
    knownItems.push(...event.items);
    appendNewQueueItems(event.items);
    loadNext();
    return;
  }

  knownItems = [...event.items];
  // Change the scroll axis before calculating the new layout geometry.
  syncRootScrollerFromVisibility();
  if (event.snapshot.sessionId !== activeSessionId) {
    hardReset(event.snapshot.sessionId, event.items);
  } else {
    softReflow(event.items);
  }
  syncRootScrollerFromVisibility();
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
  queueHead = 0;
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
  queueHead = 0;
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

function queuedItemCount(): number {
  return queue.length - queueHead;
}

function shiftQueuedItem(): LegacyFlowItem | undefined {
  if (queueHead >= queue.length) {
    return undefined;
  }
  const item = queue[queueHead];
  queueHead += 1;

  if (queueHead >= 1024 && queueHead * 2 >= queue.length) {
    queue = queue.slice(queueHead);
    queueHead = 0;
  }
  return item;
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

function currentTrackCount(): number {
  return Number.isInteger(props.trackCount)
    ? Math.min(MAX_TRACK_COUNT, Math.max(MIN_TRACK_COUNT, props.trackCount))
    : 4;
}

function buildLayoutShell(): void {
  const imgbox = imgboxElement.value;
  if (imgbox === null) return;

  imgbox.replaceChildren();
  columnElements = [];
  columnHeights = [];
  masonryFrontierHeight = 0;
  laneElements = [];
  laneWidths = [];
  horizontalFrontierWidth = 0;

  if (snapshot.value.layoutMode === "masonry") {
    imgbox.className = "legacy-imgbox masonry";
    for (let index = 0; index < currentTrackCount(); index += 1) {
      const column = document.createElement("div");
      column.className = "legacy-column";
      imgbox.appendChild(column);
      columnElements.push(column);
      columnHeights.push(0);
    }
    updateMasonryColumnWidth();
  } else {
    imgbox.className = "legacy-imgbox horizontal";
    for (let index = 0; index < currentTrackCount(); index += 1) {
      const lane = document.createElement("div");
      lane.className = "legacy-lane";
      imgbox.appendChild(lane);
      laneElements.push(lane);
      laneWidths.push(0);
    }
    updateHorizontalLaneHeight();
  }
  updateFlowContentTop();
}

function updateHorizontalLaneHeight(): void {
  const viewport = viewportElement.value;
  const imgbox = imgboxElement.value;
  if (viewport === null || imgbox === null) return;
  const count = currentTrackCount();
  const available = Math.max(1,
    viewport.clientHeight - 2 * LEGACY_EDGE_GAP -
    (count - 1) * LEGACY_ROW_GAP,
  );
  horizontalLaneHeight = Math.max(1, available / count);
  imgbox.style.setProperty("--wf-lane-height", `${horizontalLaneHeight}px`);
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
  const availableWidth = imgbox?.clientWidth ?? viewport?.clientWidth ?? 1;
  const totalGap = LEGACY_COLUMN_GAP * Math.max(0, currentTrackCount() - 1);
  masonryColumnWidth = Math.max(1, (availableWidth - totalGap) / currentTrackCount());
}

function reconcileMasonryHeightsFromLayout(): void {
  if (snapshot.value.layoutMode !== "masonry" || columnElements.length === 0) {
    return;
  }

  columnHeights = columnElements.map((column) => column.offsetHeight);
  updateMasonryFrontier();
}

function reconcileHorizontalWidthsFromLayout(): void {
  if (snapshot.value.layoutMode !== "justified" || laneElements.length === 0) {
    return;
  }
  laneWidths = laneElements.map((lane) => lane.offsetWidth);
  horizontalFrontierWidth = Math.min(...laneWidths);
}

function rebuildMasonryHeightModel(): void {
  updateFlowContentTop();
  if (snapshot.value.layoutMode === "masonry") {
    updateMasonryColumnWidth();
    reconcileMasonryHeightsFromLayout();
  } else {
    updateHorizontalLaneHeight();
    reconcileHorizontalWidthsFromLayout();
  }
}

function estimatedMasonryImageHeight(img: HTMLImageElement): number {
  if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
    return 0;
  }
  return masonryColumnWidth * (img.naturalHeight / img.naturalWidth);
}

function estimatedHorizontalImageWidth(img: HTMLImageElement): number {
  if (img.naturalWidth <= 0 || img.naturalHeight <= 0) return 0;
  return horizontalLaneHeight * (img.naturalWidth / img.naturalHeight);
}

function shortestLaneIndex(): number {
  if (laneWidths.length === 0) return -1;
  let shortest = 0;
  for (let index = 1; index < laneWidths.length; index += 1) {
    if (laneWidths[index] < laneWidths[shortest]) shortest = index;
  }
  return shortest;
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
  if (!flowVisible || imgboxElement.value === null) return false;
  if (renderedCount === 0) return true;
  if (snapshot.value.layoutMode === "justified") {
    const viewport = viewportElement.value;
    if (viewport === null) return false;
    return viewport.scrollLeft + viewport.clientWidth >=
      horizontalFrontierWidth - viewport.clientWidth;
  }

  const root = document.documentElement;
  const documentFrontier = flowContentTop + masonryFrontierHeight;
  return root.scrollTop + root.clientHeight >=
    documentFrontier - root.clientHeight;
}

function hasPendingVisualWork(): boolean {
  return loading > 0 || pendingAppends.length > 0;
}

function loadNext(): void {
  if (destroyed || !flowVisible) {
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

  while (activeBatchRemaining > 0 && queuedItemCount() > 0) {
    const item = shiftQueuedItem();
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
  if (activeBatchRemaining === 0 || queuedItemCount() > 0) {
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

  const masonryFragments =
    snapshot.value.layoutMode === "masonry"
      ? columnElements.map(() => document.createDocumentFragment())
      : null;
  const horizontalFragments =
    snapshot.value.layoutMode === "justified"
      ? laneElements.map(() => document.createDocumentFragment())
      : null;

  if (masonryFragments !== null && pendingAppends.length > 0) {
    reconcileMasonryHeightsFromLayout();
  } else if (horizontalFragments !== null && pendingAppends.length > 0) {
    reconcileHorizontalWidthsFromLayout();
  }

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

    appendWrap(pending.wrap, masonryFragments, horizontalFragments);
    if (pending.completesLoad) {
      loading = Math.max(0, loading - 1);
    }
    committed += 1;
  }

  if (masonryFragments !== null) {
    for (let index = 0; index < masonryFragments.length; index += 1) {
      const fragment = masonryFragments[index];
      const column = columnElements[index];
      if (fragment.childNodes.length > 0 && column !== undefined) {
        column.appendChild(fragment);
      }
    }
  } else if (horizontalFragments !== null) {
    for (let index = 0; index < horizontalFragments.length; index += 1) {
      const fragment = horizontalFragments[index];
      const lane = laneElements[index];
      if (fragment.childNodes.length > 0 && lane !== undefined) {
        lane.appendChild(fragment);
      }
    }
  }

  if (pendingAppends.length > 0) {
    scheduleAppendFrame();
    return;
  }

  if (loading === 0 && activeBatchRemaining === 0) {
    scheduleLoadNext(0);
  }
}

function appendWrap(
  wrap: HTMLElement,
  masonryFragments: readonly DocumentFragment[] | null = null,
  horizontalFragments: readonly DocumentFragment[] | null = null,
): void {
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

    const fragment = masonryFragments?.[targetIndex];
    if (fragment !== undefined) {
      fragment.appendChild(wrap);
    } else {
      target.appendChild(wrap);
    }
    const gap = columnHeights[targetIndex] > 0 ? LEGACY_ROW_GAP : 0;
    columnHeights[targetIndex] += gap + estimatedMasonryImageHeight(img);
    updateMasonryFrontier();
    return;
  }

  const targetIndex = shortestLaneIndex();
  const lane = laneElements[targetIndex];
  const img = wrap.firstElementChild;
  if (targetIndex < 0 || lane === undefined || !(img instanceof HTMLImageElement)) {
    return;
  }
  const fragment = horizontalFragments?.[targetIndex];
  if (fragment !== undefined) fragment.appendChild(wrap);
  else lane.appendChild(wrap);
  const gap = laneWidths[targetIndex] > 0 ? LEGACY_ROW_GAP : 0;
  laneWidths[targetIndex] += gap + estimatedHorizontalImageWidth(img);
  horizontalFrontierWidth = Math.min(...laneWidths);
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
  if (!rootScrollEnabled) return;
  lastScrollAt = performance.now();
  loadNext();
}

function handleHorizontalScroll(): void {
  if (!flowVisible || snapshot.value.layoutMode !== "justified") return;
  savedHorizontalScrollLeft = viewportElement.value?.scrollLeft ?? 0;
  lastScrollAt = performance.now();
  loadNext();
}

function handleHorizontalWheel(event: WheelEvent): void {
  if (!flowVisible || snapshot.value.layoutMode !== "justified" ||
      event.ctrlKey || event.metaKey) return;
  const viewport = viewportElement.value;
  if (viewport === null) return;
  event.preventDefault();
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
    ? event.deltaX : event.deltaY;
  const multiplier = event.deltaMode === 1 ? 16 :
    event.deltaMode === 2 ? viewport.clientWidth : 1;
  viewport.scrollLeft += delta * multiplier;
  lastScrollAt = performance.now();
  loadNext();
}

function handleWindowResize(): void {
  rebuildMasonryHeightModel();
  loadNext();
}

function syncRootScrollerFromVisibility(): void {
  const viewport = viewportElement.value;
  const visible = viewport !== null && viewport.style.display !== "none";
  const useRoot = visible && snapshot.value.layoutMode === "masonry";
  const root = document.documentElement;
  const changed = flowVisible !== visible || rootScrollEnabled !== useRoot;
  if (!changed) return;

  if (rootScrollEnabled) {
    savedFlowScrollTop = root.scrollTop;
  } else if (flowVisible && snapshot.value.layoutMode === "justified") {
    savedHorizontalScrollLeft = viewport?.scrollLeft ?? 0;
  }

  flowVisible = visible;
  rootScrollEnabled = useRoot;
  root.classList.toggle(ROOT_SCROLL_CLASS, useRoot);
  document.body.classList.toggle(ROOT_SCROLL_CLASS, useRoot);
  if (!useRoot) root.scrollTop = 0;

  viewport?.classList.toggle("horizontal", visible && !useRoot);
  if (visible) {
    window.requestAnimationFrame(() => {
      if (!flowVisible || destroyed || viewport === null) return;
      if (rootScrollEnabled) root.scrollTop = savedFlowScrollTop;
      else viewport.scrollLeft = savedHorizontalScrollLeft;
      rebuildMasonryHeightModel();
      loadNext();
    });
  }
}

function disableRootScroller(): void {
  const root = document.documentElement;
  if (rootScrollEnabled) savedFlowScrollTop = root.scrollTop;
  rootScrollEnabled = false;
  flowVisible = false;
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
  savedHorizontalScrollLeft = 0;
  if (rootScrollEnabled) document.documentElement.scrollTop = 0;
  if (viewportElement.value !== null) viewportElement.value.scrollLeft = 0;
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
  viewportElement.value?.addEventListener("wheel", handleHorizontalWheel, { passive: false });
  viewportElement.value?.addEventListener("scroll", handleHorizontalScroll, { passive: true });

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

watch(() => props.trackCount, () => {
  softReflow(knownItems);
}, { flush: "post" });

onBeforeUnmount(() => {
  destroyed = true;
  layoutEpoch += 1;
  activeBatchRemaining = 0;
  unsubscribeBrowser?.();
  unsubscribeSelection?.();
  displayObserver?.disconnect();
  viewportElement.value?.removeEventListener("wheel", handleHorizontalWheel);
  viewportElement.value?.removeEventListener("scroll", handleHorizontalScroll);
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
  padding: 14px;
  box-sizing: border-box;
}
.legacy-flow-viewport.horizontal {
  position: absolute;
  inset: 0;
  height: 100%;
  min-height: 0;
  overflow-x: scroll;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  overscroll-behavior-y: contain;
}
.legacy-imgbox.masonry {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  box-sizing: border-box;
}
.legacy-imgbox.masonry :deep(.legacy-column) {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.legacy-imgbox.horizontal {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  width: max-content;
  min-width: 100%;
  box-sizing: border-box;
}
.legacy-imgbox.horizontal :deep(.legacy-lane) {
  display: flex;
  flex: 0 0 var(--wf-lane-height);
  width: max-content;
  height: var(--wf-lane-height);
  gap: 12px;
}
:deep(.legacy-wrap) {
  position: relative;
  margin: 0;
  min-width: 0;
  cursor: pointer;
}
:deep(.legacy-wrap.selected) {
  outline: 2px solid var(--wf-accent);
  outline-offset: -2px;
}
.legacy-imgbox.masonry :deep(.legacy-wrap) {
  width: 100%;
  flex: 0 0 auto;
}
.legacy-imgbox.horizontal :deep(.legacy-wrap) {
  flex: 0 0 auto;
  width: auto;
  height: var(--wf-lane-height);
}
:deep(.legacy-image) {
  display: block;
  width: 100%;
  height: auto;
  user-select: none;
  -webkit-user-drag: none;
}
.legacy-imgbox.horizontal :deep(.legacy-image) {
  width: auto;
  height: 100%;
  max-width: none;
  object-fit: contain;
}
</style>
