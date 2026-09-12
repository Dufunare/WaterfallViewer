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
  MasonryBrowserController,
} from "../../application/browser/masonryBrowserController";

const props = defineProps<{
  browser: MasonryBrowserController;
}>();

const viewportElement = ref<HTMLElement | null>(null);
const snapshot = shallowRef(props.browser.snapshot);
const pickingSource = ref(false);
const uiError = ref<string | null>(null);

let unsubscribe: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let viewportFrame: number | null = null;

const scanStatus = computed(() => snapshot.value.scanState?.status ?? null);
const isScanning = computed(
  () =>
    scanStatus.value === "starting" ||
    scanStatus.value === "scanning" ||
    scanStatus.value === "cancelling",
);
const canCancel = computed(
  () => scanStatus.value === "starting" || scanStatus.value === "scanning",
);
const statusLabel = computed(() => {
  switch (scanStatus.value) {
    case "starting":
      return "Starting";
    case "scanning":
      return "Scanning";
    case "cancelling":
      return "Cancelling";
    case "finished":
      return "Ready";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    default:
      return "No source";
  }
});
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

async function openSource(): Promise<void> {
  if (pickingSource.value) {
    return;
  }

  pickingSource.value = true;
  uiError.value = null;
  try {
    const opened = await props.browser.pickAndOpenSource();
    if (opened && viewportElement.value !== null) {
      viewportElement.value.scrollTop = 0;
      syncViewport();
    }
  } catch (error) {
    uiError.value = normalizeError(error);
  } finally {
    pickingSource.value = false;
  }
}

async function cancelScan(): Promise<void> {
  uiError.value = null;
  try {
    await props.browser.cancelScan();
  } catch (error) {
    uiError.value = normalizeError(error);
  }
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as { message?: unknown };
    if (typeof candidate.message === "string") {
      return candidate.message;
    }
  }
  return String(error);
}

onMounted(() => {
  unsubscribe = props.browser.subscribe((nextSnapshot) => {
    snapshot.value = nextSnapshot;
  });

  const element = viewportElement.value;
  if (element !== null) {
    resizeObserver = new ResizeObserver(() => {
      scheduleViewportSync();
    });
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
  <main class="browser-shell">
    <header class="browser-toolbar">
      <div class="brand-block">
        <span class="brand-name">WaterfallViewer</span>
        <span v-if="snapshot.sourceDisplayName" class="source-name" :title="snapshot.sourceDisplayName">
          {{ snapshot.sourceDisplayName }}
        </span>
      </div>

      <div class="toolbar-stats" aria-live="polite">
        <span class="status-dot" :class="{ active: isScanning, failed: scanStatus === 'failed' }" />
        <span>{{ statusLabel }}</span>
        <span v-if="snapshot.sessionId" class="stat-separator">·</span>
        <span v-if="snapshot.sessionId">{{ snapshot.itemCount }} media</span>
        <span v-if="snapshot.deferredCount > 0" class="muted-stat">
          {{ snapshot.deferredCount }} deferred
        </span>
      </div>

      <div class="toolbar-actions">
        <button
          v-if="canCancel"
          class="toolbar-button secondary"
          type="button"
          @click="cancelScan"
        >
          Cancel
        </button>
        <button
          class="toolbar-button"
          type="button"
          :disabled="pickingSource"
          @click="openSource"
        >
          {{ pickingSource ? "Opening…" : "Open folder" }}
        </button>
      </div>
    </header>

    <div v-if="uiError || snapshot.scanState?.error" class="error-strip" role="alert">
      {{ uiError ?? snapshot.scanState?.error?.message }}
    </div>

    <section
      ref="viewportElement"
      class="media-viewport"
      aria-label="Media browser"
      @scroll.passive="scheduleViewportSync"
    >
      <div class="masonry-canvas" :style="canvasStyle">
        <figure
          v-for="tile in snapshot.tiles"
          :key="tile.mediaId"
          class="media-tile"
          :class="{ overscan: tile.priority === 'overscan' }"
          :style="tileStyle(tile)"
          :title="tile.relativePath"
        >
          <img
            v-if="tile.thumbnailStatus === 'ready' && tile.thumbnailUri"
            class="media-image"
            :src="tile.thumbnailUri"
            :alt="tile.name"
            decoding="async"
            loading="eager"
            draggable="false"
          />
          <div v-else class="media-placeholder">
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

      <div v-if="snapshot.sessionId === null" class="empty-state">
        <p class="empty-title">Choose a media folder</p>
        <p class="empty-copy">
          Files are discovered recursively and streamed into the view as they are found.
        </p>
        <button class="empty-action" type="button" :disabled="pickingSource" @click="openSource">
          Open folder
        </button>
      </div>

      <div
        v-else-if="snapshot.itemCount === 0 && !isScanning"
        class="empty-state"
      >
        <p class="empty-title">No supported media found</p>
        <p class="empty-copy">Choose another folder to continue browsing.</p>
      </div>
    </section>
  </main>
</template>

<style scoped>
.browser-shell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--wf-bg);
}

.browser-toolbar {
  height: var(--wf-toolbar-height);
  flex: 0 0 var(--wf-toolbar-height);
  display: grid;
  grid-template-columns: minmax(150px, 1fr) auto minmax(150px, 1fr);
  align-items: center;
  gap: 16px;
  padding: 0 14px;
  border-bottom: 1px solid var(--wf-border);
  background: var(--wf-surface);
  user-select: none;
}

.brand-block,
.toolbar-actions,
.toolbar-stats {
  min-width: 0;
  display: flex;
  align-items: center;
}

.brand-block {
  gap: 10px;
}

.brand-name {
  font-size: 0.86rem;
  font-weight: 650;
  letter-spacing: 0.015em;
  white-space: nowrap;
}

.source-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.78rem;
  color: var(--wf-text-muted);
}

.toolbar-stats {
  justify-content: center;
  gap: 7px;
  font-size: 0.76rem;
  color: var(--wf-text-muted);
  white-space: nowrap;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
}

.status-dot.active {
  background: #9ca3af;
  box-shadow: 0 0 0 3px rgba(156, 163, 175, 0.12);
}

.status-dot.failed {
  background: #ef8b8b;
}

.stat-separator,
.muted-stat {
  opacity: 0.65;
}

.toolbar-actions {
  justify-content: flex-end;
  gap: 8px;
}

.toolbar-button,
.empty-action {
  border: 1px solid var(--wf-border);
  border-radius: 8px;
  background: var(--wf-accent);
  color: #111318;
  cursor: pointer;
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.toolbar-button {
  min-height: 32px;
  padding: 5px 11px;
  font-size: 0.78rem;
}

.toolbar-button.secondary {
  background: transparent;
  color: var(--wf-text-muted);
}

.toolbar-button:disabled,
.empty-action:disabled {
  cursor: default;
  opacity: 0.48;
}

.toolbar-button:not(:disabled):active,
.empty-action:not(:disabled):active {
  transform: translateY(1px);
}

.error-strip {
  z-index: 2;
  flex: 0 0 auto;
  padding: 7px 14px;
  border-bottom: 1px solid rgba(239, 139, 139, 0.25);
  background: rgba(120, 35, 35, 0.24);
  color: #ffcaca;
  font-size: 0.78rem;
}

.media-viewport {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  contain: strict;
}

.masonry-canvas {
  position: relative;
  width: 100%;
}

.media-tile {
  position: absolute;
  top: 0;
  left: 0;
  margin: 0;
  overflow: hidden;
  background: var(--wf-surface-raised);
  contain: layout paint style;
  content-visibility: auto;
}

.media-tile.overscan {
  pointer-events: none;
}

.media-image {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  user-select: none;
  -webkit-user-drag: none;
}

.media-placeholder {
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

.empty-state {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  padding: 28px;
  text-align: center;
  pointer-events: none;
}

.empty-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.empty-copy {
  width: min(420px, 80vw);
  margin: 8px 0 18px;
  color: var(--wf-text-muted);
  font-size: 0.82rem;
  line-height: 1.5;
}

.empty-action {
  min-height: 36px;
  padding: 7px 14px;
  pointer-events: auto;
  font-size: 0.82rem;
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

@media (max-width: 720px) {
  .browser-toolbar {
    grid-template-columns: 1fr auto;
  }

  .toolbar-stats {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .loading-pulse {
    animation: none;
  }
}
</style>
