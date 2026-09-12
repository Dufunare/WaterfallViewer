<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from "vue";

import type {
  BrowserLayoutMode,
  MediaBrowserController,
} from "../../application/browser/mediaBrowserController";
import type { CanvasBrowserController } from "../../application/canvas/canvasBrowserController";
import type { ViewerWorkspaceController } from "../../application/viewer/viewerWorkspaceController";
import FlowViewport from "../components/FlowViewport.vue";

const CanvasViewport = defineAsyncComponent(
  () => import("../components/CanvasViewport.vue"),
);

type ViewerMode = BrowserLayoutMode | "canvas";

const props = defineProps<{
  workspace: ViewerWorkspaceController;
  flowBrowser: MediaBrowserController;
  createCanvasBrowser: () => CanvasBrowserController;
}>();
const emit = defineEmits<{
  activate: [mediaId: string];
}>();

const mode = ref<ViewerMode>(props.flowBrowser.snapshot.layoutMode);
const workspace = shallowRef(props.workspace.snapshot);
const pickingSource = ref(false);
const uiError = ref<string | null>(null);

let unsubscribeWorkspace: (() => void) | null = null;

const scanStatus = computed(() => workspace.value.scanState?.status ?? null);
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
const emptyTitle = computed(() =>
  workspace.value.sessionId === null
    ? "Choose a media folder"
    : "No supported media found",
);
const emptyCopy = computed(() =>
  workspace.value.sessionId === null
    ? "Files are discovered recursively and streamed into the active view as they are found."
    : "Choose another folder to continue browsing.",
);
const showEmptyState = computed(
  () =>
    workspace.value.sessionId === null ||
    (workspace.value.itemCount === 0 && !isScanning.value),
);
const activeError = computed(
  () => uiError.value ?? workspace.value.scanState?.error?.message ?? null,
);

function setMode(nextMode: ViewerMode): void {
  if (nextMode === mode.value) {
    return;
  }

  if (nextMode !== "canvas") {
    props.flowBrowser.setLayoutMode(nextMode);
  }
  mode.value = nextMode;
}

async function openSource(): Promise<void> {
  if (pickingSource.value) {
    return;
  }

  pickingSource.value = true;
  uiError.value = null;
  try {
    await props.workspace.pickAndOpenSource();
  } catch (error) {
    uiError.value = normalizeError(error);
  } finally {
    pickingSource.value = false;
  }
}

async function cancelScan(): Promise<void> {
  uiError.value = null;
  try {
    await props.workspace.cancelScan();
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
  unsubscribeWorkspace = props.workspace.subscribe((snapshot) => {
    workspace.value = snapshot;
  });
});

onBeforeUnmount(() => {
  unsubscribeWorkspace?.();
});
</script>

<template>
  <main class="viewer-shell">
    <header class="viewer-toolbar">
      <div class="brand-block">
        <span class="brand-name">WaterfallViewer</span>
        <span
          v-if="workspace.sourceDisplayName"
          class="source-name"
          :title="workspace.sourceDisplayName"
        >
          {{ workspace.sourceDisplayName }}
        </span>
      </div>

      <div class="viewer-modes" role="group" aria-label="Viewer mode">
        <button
          class="mode-button"
          :class="{ active: mode === 'masonry' }"
          type="button"
          :aria-pressed="mode === 'masonry'"
          @click="setMode('masonry')"
        >
          Columns
        </button>
        <button
          class="mode-button"
          :class="{ active: mode === 'justified' }"
          type="button"
          :aria-pressed="mode === 'justified'"
          @click="setMode('justified')"
        >
          Rows
        </button>
        <button
          class="mode-button"
          :class="{ active: mode === 'canvas' }"
          type="button"
          :aria-pressed="mode === 'canvas'"
          @click="setMode('canvas')"
        >
          Canvas
        </button>
      </div>

      <div class="toolbar-stats" aria-live="polite">
        <span
          class="status-dot"
          :class="{ active: isScanning, failed: scanStatus === 'failed' }"
        />
        <span>{{ statusLabel }}</span>
        <span v-if="workspace.sessionId" class="stat-separator">·</span>
        <span v-if="workspace.sessionId">{{ workspace.itemCount }} media</span>
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

    <div v-if="activeError" class="error-strip" role="alert">
      {{ activeError }}
    </div>

    <section class="viewer-stage">
      <FlowViewport
        v-show="mode !== 'canvas'"
        class="viewer-pane"
        :browser="flowBrowser"
        @activate="emit('activate', $event)"
      />

      <Suspense v-if="mode === 'canvas'">
        <CanvasViewport
          class="viewer-pane"
          :create-browser="createCanvasBrowser"
          @activate="emit('activate', $event)"
        />
        <template #fallback>
          <div class="canvas-loading">Loading canvas renderer…</div>
        </template>
      </Suspense>

      <div v-if="showEmptyState" class="empty-state">
        <p class="empty-title">{{ emptyTitle }}</p>
        <p class="empty-copy">{{ emptyCopy }}</p>
        <button
          class="empty-action"
          type="button"
          :disabled="pickingSource"
          @click="openSource"
        >
          Open folder
        </button>
      </div>
    </section>
  </main>
</template>

<style scoped>
.viewer-shell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--wf-bg);
}

.viewer-toolbar {
  height: var(--wf-toolbar-height);
  flex: 0 0 var(--wf-toolbar-height);
  display: grid;
  grid-template-columns: minmax(150px, 1fr) auto auto minmax(190px, 1fr);
  align-items: center;
  gap: 14px;
  padding: 0 14px;
  border-bottom: 1px solid var(--wf-border);
  background: var(--wf-surface);
  user-select: none;
}

.brand-block,
.viewer-modes,
.toolbar-stats,
.toolbar-actions {
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

.viewer-modes {
  padding: 2px;
  border: 1px solid var(--wf-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.025);
}

.mode-button {
  min-height: 27px;
  padding: 3px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--wf-text-muted);
  font-size: 0.72rem;
  cursor: pointer;
}

.mode-button.active {
  background: var(--wf-surface-raised);
  color: var(--wf-text);
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

.stat-separator {
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
  z-index: 4;
  flex: 0 0 auto;
  padding: 7px 14px;
  border-bottom: 1px solid rgba(239, 139, 139, 0.25);
  background: rgba(120, 35, 35, 0.24);
  color: #ffcaca;
  font-size: 0.78rem;
}

.viewer-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.viewer-pane {
  position: absolute;
  inset: 0;
}

.canvas-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--wf-text-muted);
  font-size: 0.78rem;
  background: var(--wf-bg);
}

.empty-state {
  position: absolute;
  z-index: 5;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  padding: 28px;
  text-align: center;
  background: var(--wf-bg);
}

.empty-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.empty-copy {
  width: min(440px, 80vw);
  margin: 8px 0 18px;
  color: var(--wf-text-muted);
  font-size: 0.82rem;
  line-height: 1.5;
}

.empty-action {
  min-height: 36px;
  padding: 7px 14px;
  font-size: 0.82rem;
}

@media (max-width: 820px) {
  .viewer-toolbar {
    grid-template-columns: minmax(120px, 1fr) auto auto;
  }

  .toolbar-stats {
    display: none;
  }
}

@media (max-width: 620px) {
  .source-name,
  .toolbar-button.secondary {
    display: none;
  }

  .viewer-toolbar {
    gap: 8px;
    padding: 0 8px;
  }

  .mode-button {
    padding-inline: 7px;
  }
}
</style>
