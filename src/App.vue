<script setup lang="ts">
import type { MediaBrowserController } from "./application/browser/mediaBrowserController";
import type { CanvasBrowserController } from "./application/canvas/canvasBrowserController";
import type { ViewerWorkspaceController } from "./application/viewer/viewerWorkspaceController";
import ViewerPage from "./presentation/pages/ViewerPage.vue";

defineProps<{
  workspace: ViewerWorkspaceController;
  flowBrowser: MediaBrowserController;
  createCanvasBrowser: () => CanvasBrowserController;
}>();
</script>

<template>
  <ViewerPage
    :workspace="workspace"
    :flow-browser="flowBrowser"
    :create-canvas-browser="createCanvasBrowser"
  />
</template>
