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
import type {
  MediaQueryController,
  MediaQuerySnapshot,
  MediaSort,
} from "../../application/query/mediaQueryController";
import type { ViewerWorkspaceController } from "../../application/viewer/viewerWorkspaceController";
import FlowViewport from "../components/FlowViewport.vue";

const CanvasViewport = defineAsyncComponent(
  () => import("../components/CanvasViewport.vue"),
);

type ViewerMode = BrowserLayoutMode | "canvas";
type MediaFilterPreset = "all" | "images" | "video" | "audio";

const filterPresets: readonly MediaFilterPreset[] = [
  "all",
  "images",
  "video",
  "audio",
];
const sortOptions: ReadonlyArray<{ value: MediaSort; label: string }> = [
  { value: "source", label: "Source order" },
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "modified-desc", label: "Newest" },
  { value: "modified-asc", label: "Oldest" },
  { value: "size-desc", label: "Largest" },
  { value: "size-asc", label: "Smallest" },
];

const props = defineProps<{
  workspace: ViewerWorkspaceController;
  query: MediaQueryController;
  flowBrowser: MediaBrowserController;
  createCanvasBrowser: () => CanvasBrowserController;
}>();
const emit = defineEmits<{
  activate: [mediaId: string];
}>();

const mode = ref<ViewerMode>(props.flowBrowser.snapshot.layoutMode);
const workspace = shallowRef(props.workspace.snapshot);
const queryState = shallowRef<MediaQuerySnapshot>(props.query.snapshot);
const pickingSource = ref(false);
const uiError = ref<string | null>(null);

let unsubscribeWorkspace: (() => void) | null = null;
let unsubscribeQuery: (() => void) | null = null;

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
const activeFilter = computed<MediaFilterPreset>(() => {
  const kinds = queryState.value.includedKinds;
  if (sameKinds(kinds, ["image", "animated-image"])) {
    return "images";
  }
  if (sameKinds(kinds, ["video"])) {
    return "video";
  }
  if (sameKinds(kinds, ["audio"])) {
    return "audio";
  }
  return "all";
});
const filterActive = computed(
  () => queryState.value.includedKinds.length !== 4,
);
const filteredEmpty = computed(
  () =>
    workspace.value.sessionId !== null &&
    workspace.value.itemCount > 0 &&
    queryState.value.matchedItemCount === 0 &&
    !isScanning.value,
);
const emptyTitle = computed(() => {
  if (workspace.value.sessionId === null) {
    return "Choose a media folder";
  }
  if (filteredEmpty.value) {
    return "No media matches this filter";
  }
  return "No supported media found";
});
const emptyCopy = computed(() => {
  if (workspace.value.sessionId === null) {
    return "Files are discovered recursively and streamed into the active view as they are found.";
  }
  if (filteredEmpty.value) {
    return "Show all media or choose another media type to continue browsing this folder.";
  }
  return "Choose another folder to continue browsing.";
});
const showEmptyState = computed(
  () =>
    workspace.value.sessionId === null ||
    (workspace.value.itemCount === 0 && !isScanning.value) ||
    filteredEmpty.value,
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

function setFilter(preset: MediaFilterPreset): void {
  switch (preset) {
    case "all":
      props.query.reset();
      break;
    case "images":
      props.query.setIncludedKinds(["image", "animated-image"]);
      break;
    case "video":
      props.query.setIncludedKinds(["video"]);
      break;
    case "audio":
      props.query.setIncludedKinds(["audio"]);
      break;
  }
}

function handleSortChange(event: Event): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  props.query.setSort(target.value as MediaSort);
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

function handleEmptyAction(): void {
  if (filteredEmpty.value) {
    props.query.reset();
    return;
  }
  void openSource();
}

function sameKinds(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((kind, index) => kind === expected[index])
  );
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
  unsubscribeQuery = props.query.subscribe((snapshot) => {
    queryState.value = snapshot;
  });
});

onBeforeUnmount(() => {
  unsubscribeWorkspace?.();
  unsubscribeQuery?.();
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

      <div class="media-filters" role="group" aria-label="Media filter">
        <button
          v-for="preset in filterPresets"
          :key="preset"
          class="filter-button"
          :class="{ active: activeFilter === preset }"
          type="button"
          :aria-pressed="activeFilter === preset"
          @click="setFilter(preset)"
        >
          {{ preset === "all" ? "All" : preset[0].toUpperCase() + preset.slice(1) }}
        </button>
      </div>

      <label class="sort-control">
        <span class="sr-only">Sort media</span>
        <select
          class="sort-select"
          :value="queryState.sort"
          :title="queryState.sortPending ? 'Sorting will apply when scanning stops' : 'Sort media'"
          @change="handleSortChange"
        >
          <option
            v-for="option in sortOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </label>

      <div class="toolbar-stats" aria-live="polite">
        <span
          class="status-dot"
          :class="{ active: isScanning, failed: scanStatus === 'failed' }"
        />
        <span>{{ statusLabel }}</span>
        <span v-if="workspace.sessionId" class="stat-separator">·</span>
        <span v-if="workspace.sessionId">
          <template v-if="filterActive">
            {{ queryState.matchedItemCount }} / {{ workspace.itemCount }} media
          </template>
          <template v-else>{{ workspace.itemCount }} media</template>
        </span>
        <template v-if="queryState.sortPending">
          <span class="stat-separator">·</span>
          <span>sort after scan</span>
        </template>
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
          @click="handleEmptyAction"
        >
          {{ filteredEmpty ? "Show all media" : "Open folder" }}
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
  grid-template-columns: minmax(150px, 1fr) auto auto auto auto minmax(190px, 1fr);
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid var(--wf-border);
  background: var(--wf-surface);
  user-select: none;
}

.brand-block,
.viewer-modes,
.media-filters,
.sort-control,
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

.viewer-modes,
.media-filters {
  padding: 2px;
  border: 1px solid var(--wf-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.025);
}

.mode-button,
.filter-button {
  min-height: 27px;
  padding: 3px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--wf-text-muted);
  font-size: 0.72rem;
  cursor: pointer;
}

.mode-button.active,
.filter-button.active {
  background: var(--wf-surface-raised);
  color: var(--wf-text);
}

.sort-select {
  min-height: 31px;
  max-width: 132px;
  padding: 3px 24px 3px 8px;
  border: 1px solid var(--wf-border);
  border-radius: 8px;
  background: var(--wf-surface-raised);
  color: var(--wf-text-muted);
  font: inherit;
  font-size: 0.72rem;
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

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 1180px) {
  .viewer-toolbar {
    grid-template-columns: minmax(120px, 1fr) auto auto auto minmax(160px, 1fr);
  }

  .toolbar-stats {
    display: none;
  }
}

@media (max-width: 860px) {
  .media-filters {
    display: none;
  }

  .viewer-toolbar {
    grid-template-columns: minmax(120px, 1fr) auto auto minmax(150px, 1fr);
  }
}

@media (max-width: 680px) {
  .sort-control,
  .source-name,
  .toolbar-button.secondary {
    display: none;
  }

  .viewer-toolbar {
    grid-template-columns: minmax(120px, 1fr) auto minmax(145px, 1fr);
    gap: 8px;
    padding: 0 8px;
  }

  .mode-button,
  .filter-button {
    padding-inline: 7px;
  }
}
</style>
