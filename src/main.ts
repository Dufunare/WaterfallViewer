import { createApp, markRaw } from "vue";

import App from "./App.vue";
import { MediaBrowserController } from "./application/browser/mediaBrowserController";
import { MediaSessionController } from "./application/mediaSession";
import { RepresentationScheduler } from "./application/resources/representationScheduler";
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
const browser = markRaw(
  new MediaBrowserController({
    sessionController,
    sourcePicker: tauriSourcePickerPort,
    representationScheduler,
    resourcePort: tauriMediaResourcePort,
  }),
);

window.addEventListener(
  "beforeunload",
  () => {
    browser.dispose();
  },
  { once: true },
);

createApp(App, { browser }).mount("#app");
