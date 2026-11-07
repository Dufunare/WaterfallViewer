<script setup lang="ts">
import { provide } from "vue";

import type { LegacyFlowBrowserController } from "./application/browser/legacyFlowBrowserController";
import type { CanvasBrowserController } from "./application/canvas/canvasBrowserController";
import type { MediaQueryController } from "./application/query/mediaQueryController";
import type { MediaSelectionController } from "./application/selection/mediaSelectionController";
import type { MediaActivationController } from "./application/viewer/mediaActivationController";
import type { PreviewMediaDetailController } from "./application/viewer/previewMediaDetailController";
import type { ViewerWorkspaceController } from "./application/viewer/viewerWorkspaceController";
import MediaPreviewOverlay from "./presentation/components/MediaPreviewOverlay.vue";
import ViewerPage from "./presentation/pages/ViewerPage.vue";
import { mediaSelectionKey } from "./presentation/selectionContext";

const props = defineProps<{
  workspace: ViewerWorkspaceController;
  query: MediaQueryController;
  selection: MediaSelectionController;
  flowBrowser: LegacyFlowBrowserController;
  createCanvasBrowser: () => CanvasBrowserController;
  activation: MediaActivationController;
  previewDetails: PreviewMediaDetailController;
}>();

provide(mediaSelectionKey, props.selection);

function activateMedia(mediaId: string): void {
  props.activation.activate(mediaId);
}
</script>

<template>
  <ViewerPage
    :workspace="workspace"
    :query="query"
    :flow-browser="flowBrowser"
    :create-canvas-browser="createCanvasBrowser"
    @activate="activateMedia"
  />
  <MediaPreviewOverlay :activation="activation" :details="previewDetails" />
</template>
