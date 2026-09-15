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
  img?: HTMLImageElement;
  wrap?: HTMLElement;
}

const selection = useMediaSelection();
const viewportElement = ref<HTMLElement | null>(null);
const imgboxElement = ref<HTMLElement | null>(null);
const snapshot = shallowRef(props.browser.snapshot);

let unsubscribe: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let activeGeneration = -1;
let loading = 0;
let loadingAll = false;
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
  if (next.generation !== activeGeneration) {
    activeGeneration = next.generation;
    resetFlow(next.items);
    return;
  }

  for (const item of next.items) {
    if (itemStates.has(item.mediaId) || queuedIds.has(item.mediaId)) {
      continue;
    }
    queue.push(item);
    queuedIds.add(item.mediaId);
  }
  loadNext();
}

function resetFlow(items: readonly LegacyFlowItem[]): void {
  loading = 0;
  renderedCount = 0;
  loadingAll = false;
  queue = [...items];
  queuedIds = new Set(items.map((item) => item.mediaId));
  itemStates = new Map();
  if (loadTimer !== null) {
    window.clearTimeout(loadTimer);
    loadTimer = null;
  }
  buildLayoutShell();
  const viewport = viewportElement.value;
  if (viewport !== null) {
    viewport.scrollTop = 0;
  }
  loadNext();
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

function nearLoadedEnd(): boolean {
  if (loadingAll) {
    return true;
  }
  const viewport = viewportElement.value;
  const reference = minColumn ?? imgboxElement.value;
  if (viewport === null || reference === null) {
    return false;
  }

  // Mirrors the original project's gate:
  // scrollTop + clientHeight >= shortestColumnHeight - clientHeight.
  // In other words, do not request another batch until the user is within
  // roughly one viewport of the currently materialized content frontier.
  return (
    viewport.scrollTop + viewport.clientHeight >=
    reference.scrollHeight - viewport.clientHeight
  );
}

function loadNext(): void {
  if (destroyed || loading > 0 || !nearLoadedEnd()) {
    return;
  }

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
      state = { item };
      itemStates.set(item.mediaId, state);
    }

    if (state.wrap !== undefined) {
      appendWrap(state.wrap);
      continue;
    }

    const img = state.img ?? new Image();
    state.img = img;
    img.alt = item.name;
    img.draggable = false;
    img.decoding = "async";
    img.className = "legacy-image";
    img.dataset.mediaId = item.mediaId;

    loading += 1;
    let completed = false;
    const onComplete = () => {
      if (completed || destroyed) {
        return;
      }
      completed = true;
      img.onload = null;
      img.onerror = null;

      const wrap = document.createElement("figure");
      wrap.className = "legacy-wrap";
      wrap.dataset.mediaId = item.mediaId;
      wrap.title = `${item.relativePath} — click to select, double-click to open`;
      wrap.appendChild(img);
      wrap.addEventListener("click", (event) => selectItem(item.mediaId, event));
      wrap.addEventListener("dblclick", () => emit("activate", item.mediaId));
      state!.wrap = wrap;

      appendWrap(wrap);
      loading -= 1;
      loadNext();
    };

    img.onload = onComplete;
    img.onerror = onComplete;
    img.src = item.resourceUri;
  }

  // Preserve the original `setTimeout(loadNext, 0)` tail call. It lets cached
  // images / wrapper reuse advance without recursively monopolizing one task.
  scheduleLoadNext(0);
}

function appendWrap(wrap: HTMLElement): void {
  const imgbox = imgboxElement.value;
  if (imgbox === null) {
    return;
  }

  renderedCount += 1;
  wrap.id = `legacy-img-${renderedCount}`;

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
    const width = img.naturalWidth || 1;
    const height = img.naturalHeight || 1;
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

function handleScroll(): void {
  // Intentionally no viewport/controller synchronization here. Existing DOM is
  // scrolled natively; scroll only checks whether the append frontier is near.
  loadNext();
}

function handleResize(): void {
  // The original implementation only calls loadNext on resize. It does not
  // continuously relayout or virtualize existing image nodes while scrolling.
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

onMounted(() => {
  destroyed = false;
  buildLayoutShell();
  unsubscribe = props.browser.subscribe(applySnapshot);
  const viewport = viewportElement.value;
  if (viewport !== null) {
    resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(viewport);
  }
  loadNext();
});

onBeforeUnmount(() => {
  destroyed = true;
  unsubscribe?.();
  resizeObserver?.disconnect();
  if (loadTimer !== null) {
    window.clearTimeout(loadTimer);
  }
  for (const state of itemStates.values()) {
    if (state.img !== undefined) {
      state.img.onload = null;
      state.img.onerror = null;
    }
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
  content-visibility: auto;
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
