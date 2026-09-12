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

const props = defineProps<{
  browser: MediaBrowserController;
}>();
const emit = defineEmits<{
  activate: [mediaId: string];
}>();

const viewportElement = ref<HTMLElement | null>(null);
const snapshot = shallowRef(props.browser.snapshot);

let unsubscribe: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let viewportFrame: number | null = null;

const canvasStyle = computed(() => ({
  height: `${Math.max(1, snapshot.value.totalHeight)}px`,
}));

function tileStyle(tile: BrowserTile): Record<string, string> {
  return {
    width: `${tile.width}px`,
    height: `${tile.height}px`,
    transform: `translate3d(${tile.x}px, ${tile.y}px, 0)`,
  };
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
    devicePixelRatio: Math.max(1, window.devicePixelRatio || 1),
  });
}

onMounted(() => {
  unsubscribe = props.browser.subscribe((nextSnapshot) => {
    snapshot.value = nextSnapshot;
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
    <div class="flow-canvas" :style="canvasStyle">
      <figure
        v-for="tile in snapshot.tiles"
        :key="tile.mediaId"
        class="flow-tile"
        :class="{ overscan: tile.priority === 'overscan' }"
        :style="tileStyle(tile)"
        :title="`${tile.relativePath} — double-click to open`"
        @dblclick="emit('activate', tile.mediaId)"
      >
        <img
          v-if="tile.thumbnailStatus === 'ready' && tile.thumbnailUri"
          class="flow-image"
          :src="tile.thumbnailUri"
          :alt="tile.name"
          decoding="async"
          loading="eager"
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
    linear-gradient(135deg, rgba(255, 255, 255, 0.025), transparent 60%),
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
  background: rgba(255, 255, 255, 0.16);
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
