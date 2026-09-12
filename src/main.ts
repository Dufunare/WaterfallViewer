import { createApp, markRaw } from "vue";

import App from "./App.vue";
import { MediaBrowserController } from "./application/browser/mediaBrowserController";
import { CanvasBrowserController } from "./application/canvas/canvasBrowserController";
import { CanvasSceneModel } from "./application/canvas/canvasSceneModel";
import { MediaSessionController } from "./application/mediaSession";
import { RepresentationScheduler } from "./application/resources/representationScheduler";
import { MediaActivationController } from "./application/viewer/mediaActivationController";
import { ViewerWorkspaceController } from "./application/viewer/viewerWorkspaceController";
import { tauriMediaRepresentationPort } from "./platform/tauri/mediaRepresentation";
import { tauriMediaResourcePort } from "./platform/tauri/mediaResource";
import { tauriMediaScanPort } from "./platform/tauri/mediaScan";
import { tauriSourcePickerPort } from "./platform/tauri/sourcePicker";
import "./theme/base.css";

const sessionController = new MediaSessionController(tauriMediaScanPort);
const representationScheduler = new RepresentationScheduler(
  tauriMediaRepresentationPort,
  { maxConcurrent: 6 },
);
const workspace = markRaw(
  new ViewerWorkspaceController(sessionController, tauriSourcePickerPort),
);
const activation = markRaw(
  new MediaActivationController(sessionController, tauriMediaResourcePort),
);
const flowBrowser = markRaw(
  new MediaBrowserController({
    sessionController,
    sourcePicker: tauriSourcePickerPort,
    representationScheduler,
    resourcePort: tauriMediaResourcePort,
  }),
);
const canvasScene = new CanvasSceneModel({
  atlas: {
    worldWidth: 4096,
    itemHeight: 260,
    gap: 18,
    minItemWidth: 72,
  },
  viewport: {
    cellSize: 512,
    overscanPx: 0,
    thumbnailMinEdgePx: 48,
    detailMinEdgePx: 960,
    camera: {
      minZoom: 0.05,
      maxZoom: 24,
    },
  },
});

const createCanvasBrowser = () =>
  new CanvasBrowserController(
    {
      sessionController,
      sourcePicker: tauriSourcePickerPort,
      representationScheduler,
      resourcePort: tauriMediaResourcePort,
      scene: canvasScene,
    },
    {
      renderOverscanPx: 320,
      maxThumbnailEdge: 2048,
      maxDetailEdge: 4096,
    },
  );

window.addEventListener(
  "beforeunload",
  () => {
    activation.dispose();
    flowBrowser.dispose();
    workspace.dispose();
  },
  { once: true },
);

createApp(App, {
  workspace,
  flowBrowser,
  createCanvasBrowser,
  activation,
}).mount("#app");
