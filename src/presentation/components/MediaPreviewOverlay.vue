<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef } from "vue";

import type {
  ActiveMediaSnapshot,
  MediaActivationController,
} from "../../application/viewer/mediaActivationController";

const props = defineProps<{
  activation: MediaActivationController;
}>();

const active = shallowRef<ActiveMediaSnapshot | null>(props.activation.snapshot);
let unsubscribe: (() => void) | null = null;

function close(): void {
  props.activation.clear();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape" && active.value !== null) {
    event.preventDefault();
    close();
  }
}

onMounted(() => {
  unsubscribe = props.activation.subscribe((snapshot) => {
    active.value = snapshot;
  });
  window.addEventListener("keydown", onKeyDown);
});

onBeforeUnmount(() => {
  unsubscribe?.();
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
          <span class="preview-kind">{{ active.kind }}</span>
          <button class="preview-close" type="button" aria-label="Close preview" @click="close">
            ×
          </button>
        </header>

        <div class="preview-content">
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
            <audio
              :key="active.mediaId"
              class="preview-audio"
              :src="active.uri"
              controls
              preload="metadata"
            />
          </div>
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
.preview-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-title {
  font-size: 0.82rem;
  font-weight: 600;
}

.preview-path,
.preview-kind {
  color: var(--wf-text-muted);
  font-size: 0.68rem;
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
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: #050608;
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
  width: min(620px, calc(100% - 48px));
  display: grid;
  justify-items: center;
  gap: 28px;
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

  .preview-kind {
    display: none;
  }
}
</style>
