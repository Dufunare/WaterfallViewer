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

let unsubscribe: (() => void) | null = null;
let unsubscribeSelection: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let viewportFrame: number | null = null;

const FLOW_MAX_REPRESENTATION_DPR = 1.5;

const canvasStyle = computed(() => ({
  height: `${Math.max(1, snapshot.value.totalHeight)}px`,
}));
const selectedIds = computed(() => new Set(selectionSnapshot.value.selectedIds));
const orderedTiles = computed(() => [
  ...snapshot.value.tiles.filter((tile) => tile.priority === "visible"),
  ...snapshot.value.tiles.filter((tile) => tile.priority !== "visible"),
]);
const columnOptions = ["auto", 1, 2, 3, 4, 5, 6, 7, 8] as const;
const rowHeightOptions = [120, 160, 220, 300, 400] as const;

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

  props.browser.setViewport({
    width: element.clientWidth,
    height: element.clientHeight,
    scrollTop: element.scrollTop,
    // Flow is an overview surface. Asking the representation pipeline to match
    // 2x/3x desktop scale factors provides little visible benefit at tile size
    // while multiplying decode/resize work. Preview/Canvas keep independent LOD.
    devicePixelRatio: Math.min(
      FLOW_MAX_REPRESENTATION_DPR,
      Math.max(1, window.devicePixelRatio || 1),
    ),
  });
}

onMounted(() => {
  unsubscribe = props.browser.subscribe((nextSnapshot) => {
    snapshot.value = nextSnapshot;
  });
  unsubscribeSelection = selection.subscribe((nextSnapshot) => {
    selectionSnapshot.value = nextSnapshot;
  });

  const element = viewportElement.value;
  if (element !== null) {
    resizeObserver = new ResizeObserver(scheduleViewportSync);
    resizeObserver.observe(element);
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
});
</script>

<template>
  <section
    ref="viewportElement"
    class="flow-viewport"
    aria-label="Flow media browser"
    @scroll.passive="scheduleViewportSync"
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
          v-if="tile.thumbnailStatus === 'ready' && tile.thumbnailUri"
          class="flow-image"
          :src="tile.thumbnailUri"
          :alt="tile.name"
          decoding="async"
          loading="eager"
          :fetchpriority="tile.priority === 'visible' ? 'high' : 'low'"
          draggable="false"
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
  user-select: none;
  -webkit-user-drag: none;
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