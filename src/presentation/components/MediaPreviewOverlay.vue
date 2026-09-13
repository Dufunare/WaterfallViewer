<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef } from "vue";

import type {
  ActiveMediaSnapshot,
  MediaActivationController,
} from "../../application/viewer/mediaActivationController";
import type {
  PreviewMediaDetailController,
  PreviewMediaDetailSnapshot,
} from "../../application/viewer/previewMediaDetailController";
import type { ViewerInputAction } from "../../platform/input/actions";
import { mapDesktopPreviewKey } from "../../platform/input/desktopPreviewInput";

const props = defineProps<{
  activation: MediaActivationController;
  details: PreviewMediaDetailController;
}>();

const active = shallowRef<ActiveMediaSnapshot | null>(props.activation.snapshot);
const detailState = shallowRef<PreviewMediaDetailSnapshot>(props.details.snapshot);
let unsubscribeActivation: (() => void) | null = null;
let unsubscribeDetails: (() => void) | null = null;

const detail = computed(() => {
  if (
    active.value === null ||
    detailState.value.mediaId !== active.value.mediaId ||
    detailState.value.status !== "ready"
  ) {
    return null;
  }
  return detailState.value.detail;
});

const detailSummary = computed(() => {
  const current = detail.value;
  if (current === null) {
    return null;
  }

  const parts: string[] = [];
  if (current.durationMs !== null) {
    parts.push(formatDuration(current.durationMs));
  }
  if (current.codec !== null && current.codec.trim().length > 0) {
    parts.push(current.codec);
  }
  return parts.length === 0 ? null : parts.join(" · ");
});

function close(): void {
  props.activation.clear();
}

function previous(): void {
  props.activation.activatePrevious();
}

function next(): void {
  props.activation.activateNext();
}

function onKeyDown(event: KeyboardEvent): void {
  const current = active.value;
  if (current === null) {
    return;
  }

  const action = mapDesktopPreviewKey(
    {
      key: event.key,
      defaultPrevented: event.defaultPrevented,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      keepsNativeArrowBehavior: keepsNativeArrowBehavior(event.target),
    },
    { hasPrevious: current.hasPrevious, hasNext: current.hasNext },
  );
  if (action === null) {
    return;
  }

  event.preventDefault();
  dispatchInputAction(action);
}

function dispatchInputAction(action: ViewerInputAction): void {
  switch (action.type) {
    case "back":
      close();
      break;
    case "previous":
      previous();
      break;
    case "next":
      next();
      break;
    default:
      break;
  }
}

function keepsNativeArrowBehavior(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.closest("video, audio, input, textarea, select, [role='slider']") !== null
  );
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

onMounted(() => {
  unsubscribeActivation = props.activation.subscribe((snapshot) => {
    active.value = snapshot;
  });
  unsubscribeDetails = props.details.subscribe((snapshot) => {
    detailState.value = snapshot;
  });
  window.addEventListener("keydown", onKeyDown);
});

onBeforeUnmount(() => {
  unsubscribeActivation?.();
  unsubscribeDetails?.();
  window.removeEventListener("keydown", onKeyDown);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="active"
      class="preview-backdrop"
      role="dialog"
      aria-modal="true"
      :aria-label="`Preview ${active.name}`"
      @pointerdown.self="close"
    >
      <section class="preview-panel" @pointerdown.stop>
        <header class="preview-header">
          <div class="preview-title-block">
            <strong class="preview-title" :title="active.name">{{ active.name }}</strong>
            <span class="preview-path" :title="active.relativePath">
              {{ active.relativePath }}
            </span>
          </div>
          <div class="preview-meta">
            <span
              v-if="detailSummary"
              class="preview-detail"
              :title="detailSummary"
            >
              {{ detailSummary }}
            </span>
            <span
              v-else-if="detailState.mediaId === active.mediaId && detailState.status === 'loading'"
              class="preview-detail"
            >
              Reading metadata…
            </span>
            <span class="preview-position">{{ active.position }} / {{ active.totalItems }}</span>
            <span class="preview-kind">{{ active.kind }}</span>
          </div>
          <button class="preview-close" type="button" aria-label="Close preview" @click="close">
            ×
          </button>
        </header>

        <div class="preview-content">
          <button
            class="preview-nav preview-nav-previous"
            type="button"
            aria-label="Previous media"
            :disabled="!active.hasPrevious"
            @pointerdown.stop
            @click="previous"
          >
            ‹
          </button>

          <img
            v-if="active.kind === 'image' || active.kind === 'animated-image'"
            :key="active.mediaId"
            class="preview-image"
            :src="active.uri"
            :alt="active.name"
            draggable="false"
          />
          <video
            v-else-if="active.kind === 'video'"
            :key="active.mediaId"
            class="preview-video"
            :src="active.uri"
            controls
            preload="metadata"
          />
          <div v-else class="preview-audio-shell">
            <div class="audio-mark" aria-hidden="true">♪</div>
            <div
              v-if="detail?.kind === 'audio' && (detail.title || detail.artist)"
              class="audio-info"
            >
              <strong v-if="detail.title" class="audio-title">{{ detail.title }}</strong>
              <span v-if="detail.artist" class="audio-artist">{{ detail.artist }}</span>
            </div>
            <audio
              :key="active.mediaId"
              class="preview-audio"
              :src="active.uri"
              controls
              preload="metadata"
            />
          </div>

          <button
            class="preview-nav preview-nav-next"
            type="button"
            aria-label="Next media"
            :disabled="!active.hasNext"
            @pointerdown.stop
            @click="next"
          >
            ›
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.preview-backdrop {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 28px;
  background: rgba(4, 5, 7, 0.84);
  backdrop-filter: blur(12px);
}

.preview-panel {
  width: min(1120px, 100%);
  height: min(820px, 100%);
  min-height: 260px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--wf-border);
  border-radius: 12px;
  background: #0b0c0f;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
}

.preview-header {
  min-height: 48px;
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  padding: 8px 10px 8px 14px;
  border-bottom: 1px solid var(--wf-border);
  background: var(--wf-surface);
}

.preview-title-block {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.preview-title,
.preview-path,
.preview-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-title {
  font-size: 0.82rem;
  font-weight: 600;
}

.preview-path,
.preview-kind,
.preview-position,
.preview-detail,
.audio-artist {
  color: var(--wf-text-muted);
  font-size: 0.68rem;
}

.preview-meta {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview-detail {
  max-width: 220px;
  font-variant-numeric: tabular-nums;
}

.preview-position {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.preview-kind {
  padding: 3px 7px;
  border: 1px solid var(--wf-border);
  border-radius: 999px;
  text-transform: capitalize;
}

.preview-close {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--wf-text-muted);
  font-size: 1.2rem;
  line-height: 1;
  cursor: pointer;
}

.preview-close:hover {
  background: var(--wf-surface-raised);
  color: var(--wf-text);
}

.preview-content {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: #050608;
}

.preview-nav {
  position: absolute;
  z-index: 2;
  top: 50%;
  width: 42px;
  height: 64px;
  display: grid;
  place-items: center;
  transform: translateY(-50%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  background: rgba(12, 13, 17, 0.7);
  color: rgba(255, 255, 255, 0.88);
  font-size: 2rem;
  line-height: 1;
  cursor: pointer;
  backdrop-filter: blur(8px);
}

.preview-nav-previous {
  left: 14px;
}

.preview-nav-next {
  right: 14px;
}

.preview-nav:hover:not(:disabled) {
  background: rgba(28, 30, 37, 0.88);
}

.preview-nav:disabled {
  opacity: 0.2;
  cursor: default;
}

.preview-image,
.preview-video {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
}

.preview-video {
  width: 100%;
  height: 100%;
}

.preview-audio-shell {
  width: min(620px, calc(100% - 128px));
  display: grid;
  justify-items: center;
  gap: 20px;
}

.audio-mark {
  width: 112px;
  height: 112px;
  display: grid;
  place-items: center;
  border: 1px solid var(--wf-border);
  border-radius: 24px;
  background: var(--wf-surface-raised);
  color: var(--wf-text-muted);
  font-size: 3rem;
}

.audio-info {
  min-width: 0;
  max-width: 100%;
  display: grid;
  justify-items: center;
  gap: 4px;
  text-align: center;
}

.audio-title,
.audio-artist {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audio-title {
  font-size: 0.92rem;
  font-weight: 600;
}

.preview-audio {
  width: 100%;
}

@media (max-width: 700px) {
  .preview-backdrop {
    padding: 10px;
  }

  .preview-panel {
    height: 100%;
    border-radius: 9px;
  }

  .preview-detail,
  .preview-kind {
    display: none;
  }

  .preview-nav {
    width: 36px;
    height: 54px;
  }

  .preview-nav-previous {
    left: 8px;
  }

  .preview-nav-next {
    right: 8px;
  }
}
</style>
