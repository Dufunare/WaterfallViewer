<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from "vue";

import type {
  BrowserTile,
  MediaBrowserController,
} from "../../application/browser/mediaBrowserController";
import {
  FLOW_REVEAL_COHORT_MS,
  FLOW_REVEAL_SCAN_STEP_MS,
  selectFlowRevealBatch,
} from "../flowRevealPolicy";
import {
  FLOW_SCRUB_SETTLE_MS,
  FLOW_WHEEL_ACTIVITY_GRACE_MS,
  shouldEnterFlowScrub,
} from "../flowScrollPolicy";
import { useMediaSelection } from "../selectionContext";

const props = defineProps<{
  browser: MediaBrowserController;
}>();
const emit = defineEmits<{
  activate: [mediaId: string];
}>();

const selection = useMediaSelection();
const viewportElement = ref<HTMLElement | null>(null);
const snapshot = shallowRef(props.browser.snapshot);
const selectionSnapshot = shallowRef(selection.snapshot);
const isScrubbing = ref(false);
const scrollDirection = ref<-1 | 0 | 1>(0);
const liveScrollTop = ref(0);
const liveViewportHeight = ref(0);
const revealRevision = ref(0);

let unsubscribe: (() => void) | null = null;
let unsubscribeSelection: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let viewportFrame: number | null = null;
let scrubSettleTimer: number | null = null;
let revealTimer: number | null = null;
let lastScrollTop: number | null = null;
let lastScrollAt = 0;
let lastWheelAt = Number.NEGATIVE_INFINITY;
let revealSessionId: string | null = null;

const revealedMediaIds = new Set<string>();
const pendingRevealMediaIds = new Set<string>();

const FLOW_MAX_REPRESENTATION_DPR = 1.5;
const FLOW_BIDIRECTIONAL_EAGER_SCREENS = 1.5;
const FLOW_DIRECTIONAL_EAGER_SCREENS = 3.5;

const canvasStyle = computed(() => ({
  height: `${Math.max(1, snapshot.value.totalHeight)}px`,
}));
const selectedIds = computed(() => new Set(selectionSnapshot.value.selectedIds));
const orderedTiles = computed(() => {
  const visible = snapshot.value.tiles.filter((tile) => tile.priority === "visible");
  const overscan = snapshot.value.tiles.filter((tile) => tile.priority !== "visible");
  return [
    ...sortTilesForDirection(visible, scrollDirection.value),
    ...sortTilesForDirection(overscan, scrollDirection.value),
  ];
});
const columnOptions = ["auto", 1, 2, 3, 4, 5, 6, 7, 8] as const;
const rowHeightOptions = [120, 160, 220, 300, 400] as const;

function sortTilesForDirection(
  tiles: readonly BrowserTile[],
  direction: -1 | 0 | 1,
): BrowserTile[] {
  if (direction === 0) {
    return [...tiles].sort(compareTilesTopToBottom);
  }
  return [...tiles].sort((left, right) => {
    const vertical = compareTilesTopToBottom(left, right);
    return direction > 0 ? vertical : -vertical;
  });
}

function compareTilesTopToBottom(left: BrowserTile, right: BrowserTile): number {
  return left.y - right.y || left.x - right.x;
}

function shouldEagerLoad(tile: BrowserTile): boolean {
  if (tile.priority === "visible") {
    return true;
  }

  const viewportHeight = Math.max(1, liveViewportHeight.value);
  const top = liveScrollTop.value;
  const bottom = top + viewportHeight;
  const tileTop = tile.y;
  const tileBottom = tile.y + tile.height;
  const nearDistance = viewportHeight * FLOW_BIDIRECTIONAL_EAGER_SCREENS;
  const directionalDistance = viewportHeight * FLOW_DIRECTIONAL_EAGER_SCREENS;

  if (tileBottom >= top - nearDistance && tileTop <= bottom + nearDistance) {
    return true;
  }
  if (scrollDirection.value > 0) {
    return tileTop <= bottom + directionalDistance && tileBottom >= bottom;
  }
  if (scrollDirection.value < 0) {
    return tileBottom >= top - directionalDistance && tileTop <= top;
  }
  return false;
}

function shouldMountImage(tile: BrowserTile): boolean {
  if (tile.thumbnailStatus !== "ready" || !tile.thumbnailUri) {
    return false;
  }
  // During a deep scrub do not start new cold image work, but never tear down a
  // decoded/revealed image merely because the gesture crossed the scrub
  // threshold. This preserves the feeling of moving over one retained canvas.
  return !isScrubbing.value || isTileRevealed(tile.mediaId);
}

function isTileRevealed(mediaId: string): boolean {
  void revealRevision.value;
  return revealedMediaIds.has(mediaId);
}

async function handleImageLoad(tile: BrowserTile, event: Event): Promise<void> {
  if (revealedMediaIds.has(tile.mediaId)) {
    return;
  }

  const target = event.currentTarget;
  if (target instanceof HTMLImageElement && typeof target.decode === "function") {
    try {
      await target.decode();
    } catch {
      // `load` already proved that the resource is usable. Some engines reject
      // decode() during lifecycle races; revealing after load is still safe.
    }
  }

  if (!orderedTiles.value.some((current) => current.mediaId === tile.mediaId)) {
    return;
  }
  pendingRevealMediaIds.add(tile.mediaId);
  scheduleRevealCohort();
}

function scheduleRevealCohort(delay = FLOW_REVEAL_COHORT_MS): void {
  if (revealTimer !== null || pendingRevealMediaIds.size === 0) {
    return;
  }
  revealTimer = window.setTimeout(() => {
    revealTimer = null;
    flushRevealCohort();
  }, delay);
}

function flushRevealCohort(): void {
  if (pendingRevealMediaIds.size === 0) {
    return;
  }

  const currentTiles = orderedTiles.value;
  const currentIds = new Set(currentTiles.map((tile) => tile.mediaId));
  for (const mediaId of [...pendingRevealMediaIds]) {
    if (!currentIds.has(mediaId)) {
      pendingRevealMediaIds.delete(mediaId);
    }
  }

  const batch = selectFlowRevealBatch(
    currentTiles,
    pendingRevealMediaIds,
    scrollDirection.value,
    Math.max(1, liveViewportHeight.value),
  );

  if (batch.length === 0) {
    return;
  }

  for (const mediaId of batch) {
    pendingRevealMediaIds.delete(mediaId);
    revealedMediaIds.add(mediaId);
  }
  revealRevision.value += 1;

  if (pendingRevealMediaIds.size > 0) {
    scheduleRevealCohort(FLOW_REVEAL_SCAN_STEP_MS);
  }
}

function resetRevealState(sessionId: string | null): void {
  if (sessionId === revealSessionId) {
    return;
  }
  revealSessionId = sessionId;
  revealedMediaIds.clear();
  pendingRevealMediaIds.clear();
  revealRevision.value += 1;
  if (revealTimer !== null) {
    window.clearTimeout(revealTimer);
    revealTimer = null;
  }
}

function tileStyle(tile: BrowserTile): Record<string, string> {
  return {
    width: `${tile.width}px`,
    height: `${tile.height}px`,
    transform: `translate3d(${tile.x}px, ${tile.y}px, 0)`,
  };
}

function selectTile(tile: BrowserTile, event: MouseEvent): void {
  if (event.ctrlKey || event.metaKey) {
    selection.toggle(tile.mediaId);
  } else {
    selection.replace(tile.mediaId);
  }
}

function handleColumnCountChange(event: Event): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  props.browser.setColumnCount(
    target.value === "auto" ? "auto" : Number(target.value),
  );
}

function handleRowHeightChange(event: Event): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  props.browser.setJustifiedTargetRowHeight(Number(target.value));
}

function handleWheel(): void {
  lastWheelAt = performance.now();
  if (isScrubbing.value) {
    isScrubbing.value = false;
    if (scrubSettleTimer !== null) {
      window.clearTimeout(scrubSettleTimer);
      scrubSettleTimer = null;
    }
  }
}

function handleScroll(): void {
  const element = viewportElement.value;
  if (element !== null && element.clientHeight > 0) {
    const now = performance.now();
    liveScrollTop.value = element.scrollTop;
    liveViewportHeight.value = element.clientHeight;
    if (lastScrollTop !== null) {
      const delta = element.scrollTop - lastScrollTop;
      if (delta !== 0) {
        scrollDirection.value = delta > 0 ? 1 : -1;
      }
      const elapsedMs = Math.max(1, now - lastScrollAt);
      if (
        shouldEnterFlowScrub({
          previousScrollTop: lastScrollTop,
          scrollTop: element.scrollTop,
          viewportHeight: element.clientHeight,
          elapsedMs,
          recentWheel: now - lastWheelAt <= FLOW_WHEEL_ACTIVITY_GRACE_MS,
        })
      ) {
        isScrubbing.value = true;
      }
    }
    lastScrollTop = element.scrollTop;
    lastScrollAt = now;

    if (isScrubbing.value) {
      scheduleScrubSettle();
    }
  }

  scheduleViewportSync();
}

function scheduleScrubSettle(): void {
  if (scrubSettleTimer !== null) {
    window.clearTimeout(scrubSettleTimer);
  }
  scrubSettleTimer = window.setTimeout(() => {
    scrubSettleTimer = null;
    isScrubbing.value = false;
    scheduleViewportSync();
  }, FLOW_SCRUB_SETTLE_MS);
}

function scheduleViewportSync(): void {
  if (viewportFrame !== null) {
    return;
  }
  viewportFrame = window.requestAnimationFrame(() => {
    viewportFrame = null;
    syncViewport();
  });
}

function syncViewport(): void {
  const element = viewportElement.value;
  if (element === null || element.clientWidth <= 0 || element.clientHeight <= 0) {
    return;
  }

  liveScrollTop.value = element.scrollTop;
  liveViewportHeight.value = element.clientHeight;
  props.browser.setViewport({
    width: element.clientWidth,
    height: element.clientHeight,
    scrollTop: element.scrollTop,
    devicePixelRatio: Math.min(
      FLOW_MAX_REPRESENTATION_DPR,
      Math.max(1, window.devicePixelRatio || 1),
    ),
  });
}

onMounted(() => {
  unsubscribe = props.browser.subscribe((nextSnapshot) => {
    resetRevealState(nextSnapshot.sessionId);
    snapshot.value = nextSnapshot;
  });
  unsubscribeSelection = selection.subscribe((nextSnapshot) => {
    selectionSnapshot.value = nextSnapshot;
  });

  const element = viewportElement.value;
  if (element !== null) {
    resizeObserver = new ResizeObserver(scheduleViewportSync);
    resizeObserver.observe(element);
    lastScrollTop = element.scrollTop;
    lastScrollAt = performance.now();
    liveScrollTop.value = element.scrollTop;
    liveViewportHeight.value = element.clientHeight;
  }
  scheduleViewportSync();
});

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribeSelection?.();
  resizeObserver?.disconnect();
  if (viewportFrame !== null) {
    window.cancelAnimationFrame(viewportFrame);
  }
  if (scrubSettleTimer !== null) {
    window.clearTimeout(scrubSettleTimer);
  }
  if (revealTimer !== null) {
    window.clearTimeout(revealTimer);
  }
});
</script>

<template>
  <section
    ref="viewportElement"
    class="flow-viewport"
    :class="{ scrubbing: isScrubbing }"
    aria-label="Flow media browser"
    @wheel.passive="handleWheel"
    @scroll.passive="handleScroll"
  >
    <div class="flow-density-controls" aria-label="Flow density controls">
      <label v-if="snapshot.layoutMode === 'masonry'" class="density-control">
        <span>Columns</span>
        <select :value="snapshot.columnCount" @change="handleColumnCountChange">
          <option
            v-for="option in columnOptions"
            :key="String(option)"
            :value="option"
          >
            {{ option === "auto" ? "Auto" : option }}
          </option>
        </select>
      </label>
      <label v-else class="density-control">
        <span>Row</span>
        <select
          :value="snapshot.justifiedTargetRowHeight"
          @change="handleRowHeightChange"
        >
          <option
            v-for="height in rowHeightOptions"
            :key="height"
            :value="height"
          >
            {{ height }} px
          </option>
        </select>
      </label>
    </div>

    <div class="flow-canvas" :style="canvasStyle">
      <figure
        v-for="tile in orderedTiles"
        :key="tile.mediaId"
        class="flow-tile"
        :class="{
          overscan: tile.priority === 'overscan',
          selected: selectedIds.has(tile.mediaId),
        }"
        :style="tileStyle(tile)"
        :title="`${tile.relativePath} — click to select, double-click to open`"
        @click="selectTile(tile, $event)"
        @dblclick="emit('activate', tile.mediaId)"
      >
        <img
          v-if="shouldMountImage(tile)"
          class="flow-image"
          :class="{ revealed: isTileRevealed(tile.mediaId) }"
          :src="tile.thumbnailUri ?? undefined"
          :alt="tile.name"
          decoding="async"
          :loading="shouldEagerLoad(tile) ? 'eager' : 'lazy'"
          :fetchpriority="tile.priority === 'visible' ? 'high' : 'low'"
          draggable="false"
          @load="handleImageLoad(tile, $event)"
        />
        <div v-else class="flow-placeholder">
          <span v-if="tile.thumbnailStatus === 'error'" class="placeholder-label">
            Preview unavailable
          </span>
          <span v-else-if="tile.thumbnailStatus === 'unsupported'" class="placeholder-label">
            {{ tile.kind }}
          </span>
          <span v-else class="loading-pulse" aria-hidden="true" />
        </div>
      </figure>
    </div>
  </section>
</template>

<style scoped>
.flow-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  contain: strict;
}

.flow-density-controls {
  position: sticky;
  top: 8px;
  z-index: 4;
  display: flex;
  justify-content: flex-end;
  width: fit-content;
  margin: 8px 8px -39px auto;
  pointer-events: auto;
}

.density-control {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 31px;
  padding: 4px 6px 4px 9px;
  border: 1px solid var(--wf-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--wf-surface) 92%, transparent);
  color: var(--wf-text-muted);
  font-size: 0.72rem;
  backdrop-filter: blur(8px);
}

.density-control select {
  min-height: 24px;
  border: 0;
  border-radius: 5px;
  background: var(--wf-surface-raised);
  color: var(--wf-text);
  font: inherit;
}

.flow-canvas {
  position: relative;
  width: 100%;
}

.flow-tile {
  position: absolute;
  top: 0;
  left: 0;
  margin: 0;
  overflow: hidden;
  background: var(--wf-surface-raised);
  contain: layout paint style;
  content-visibility: auto;
  cursor: default;
}

.flow-tile.selected {
  z-index: 1;
  box-shadow: inset 0 0 0 2px var(--wf-accent);
}

.flow-tile.overscan {
  pointer-events: none;
}

.flow-image {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  opacity: 0;
  user-select: none;
  -webkit-user-drag: none;
}

.flow-image.revealed {
  opacity: 1;
}

.flow-placeholder {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background:
    linear-gradient(135deg, var(--wf-placeholder-sheen), transparent 60%),
    var(--wf-surface-raised);
}

.placeholder-label {
  max-width: calc(100% - 24px);
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--wf-text-muted);
  font-size: 0.72rem;
  text-transform: capitalize;
  white-space: nowrap;
}

.loading-pulse {
  width: 26px;
  height: 3px;
  border-radius: 999px;
  background: var(--wf-loading-indicator);
  animation: pulse 1.1s ease-in-out infinite alternate;
}

.flow-viewport.scrubbing .loading-pulse {
  animation: none;
  opacity: 0.4;
}

@keyframes pulse {
  from {
    opacity: 0.35;
    transform: scaleX(0.7);
  }
  to {
    opacity: 1;
    transform: scaleX(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .loading-pulse {
    animation: none;
  }
}
</style>
