<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";

import type {
  LegacyFlowBrowserController,
  LegacyFlowBrowserSnapshot,
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
let activeGeneration = -1;
let layoutEpoch = 0;
let loading = 0;
let renderedCount = 0;
let columnElements: HTMLElement[] = [];
let minColumn: HTMLElement | null = null;
let queue: LegacyFlowItem[] = [];
let queuedIds = new Set<string>();
let itemStates = new Map<string, LegacyItemState>();
let destroyed = false;
let loadTimer: number | null = null;

const LEGACY_BATCH_SIZE = 25;
const LEGACY_COLUMN_COUNT = 4;
const LEGACY_COLUMN_GAP = 10;
const LEGACY_ROW_GAP = 10;
const LEGACY_JUSTIFIED_HEIGHT = 220;

function applySnapshot(next: LegacyFlowBrowserSnapshot): void {
  snapshot.value = next;

  if (next.sessionId !== activeSessionId) {
    hardReset(next);
    return;
  }

  if (next.generation !== activeGeneration) {
    activeGeneration = next.generation;
    softReflow(next.items);
    return;
  }

  appendNewQueueItems(next.items);
  loadNext();
}

function hardReset(next: LegacyFlowBrowserSnapshot): void {
  cancelScheduledLoad();
  layoutEpoch += 1;
  loading = 0;
  renderedCount = 0;
  activeSessionId = next.sessionId;
  activeGeneration = next.generation;
  queue = [];
  queuedIds.clear();

  for (const state of itemStates.values()) {
    detachImageCallbacks(state);
  }
  itemStates.clear();

  buildLayoutShell();
  scrollToStart();
  appendNewQueueItems(next.items);
  loadNext();
}

function softReflow(items: readonly LegacyFlowItem[]): void {
  cancelScheduledLoad();
  layoutEpoch += 1;
  loading = 0;
  renderedCount = 0;
  queue = [];
  queuedIds.clear();

  // Keep completed Image/wrapper objects exactly like the original allData
  // cache. Only in-flight images are reset because their old callbacks belong
  // to a layout epoch that no longer exists.
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

  // Detach wrappers but do not destroy them. Completed wrappers remain owned by
  // itemStates and can be appended again during reflow without another decode.
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

function nearLoadedEnd(): boolean {
  const viewport = viewportElement.value;
  const reference = minColumn ?? imgboxElement.value;
  if (viewport === null || reference === null) {
    return false;
  }
  if (renderedCount === 0) {
    return true;
  }

  // Same frontier rule as the supplied frontend:
  // scrollTop + clientHeight >= shortestColumnHeight - clientHeight.
  return (
    viewport.scrollTop + viewport.clientHeight >=
    reference.scrollHeight - viewport.clientHeight
  );
}

function loadNext(): void {
  if (destroyed || loading > 0 || !nearLoadedEnd()) {
    return;
  }

  const epoch = layoutEpoch;
  let consumed = 0;
  while (consumed < LEGACY_BATCH_SIZE && queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) {
      break;
    }
    queuedIds.delete(item.mediaId);
    consumed += 1;

    let state = itemStates.get(item.mediaId);
    if (state === undefined) {
      state = {
        item,
        img: null,
        wrap: null,
        status: "idle",
        loadEpoch: epoch,
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
      // A current-epoch loading state should not normally be queued twice, but
      // do not start a duplicate request if it happens during a scan update.
      continue;
    }

    startImageLoad(state, epoch);
  }

  // Matches the old zero-delay tail call. If all 25 entries were already cached
  // wrappers, the next batch can progress without deep synchronous recursion.
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
  img.decoding = "async";
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

    // A reflow can invalidate an in-flight request. Its browser cache may still
    // benefit later, but the obsolete callback must not mutate the new layout.
    if (state.loadEpoch !== layoutEpoch || epoch !== layoutEpoch) {
      return;
    }

    const wrap = createWrap(state, img);
    state.wrap = wrap;
    state.status = "ready";
    appendWrap(wrap);

    loading = Math.max(0, loading - 1);
    if (loading === 0) {
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
  wrap.addEventListener("click", (event) => selectItem(state.item.mediaId, event));
  wrap.addEventListener("dblclick", () => emit("activate", state.item.mediaId));
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
    minColumn = columnElements.reduce((shortest, column) =>
      shortest.offsetHeight <= column.offsetHeight ? shortest : column,
    );
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

function selectItem(mediaId: string, event: MouseEvent): void {
  if (event.ctrlKey || event.metaKey) {
    selection.toggle(mediaId);
  } else {
    selection.replace(mediaId);
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
  // Intentionally tiny. Existing DOM scrolls natively and no controller state,
  // spatial index or Vue list is updated here.
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

onMounted(() => {
  destroyed = false;
  buildLayoutShell();
  unsubscribeBrowser = props.browser.subscribe(applySnapshot);
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
    <div ref="imgboxElement" class="legacy-imgbox masonry" />
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
