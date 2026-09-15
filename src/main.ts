import { mountViewerApp } from "./bootstrap/mountViewerApp";
import { createViewerRuntime } from "./bootstrap/viewerRuntime";
import { tauriMediaDetailPort } from "./platform/tauri/mediaDetail";
import { tauriMediaRepresentationPort } from "./platform/tauri/mediaRepresentation";
import {
  createTauriFlowMediaResourcePort,
  tauriMediaResourcePort,
} from "./platform/tauri/mediaResource";
import { tauriMediaScanPort } from "./platform/tauri/mediaScan";
import { tauriSourcePickerPort } from "./platform/tauri/sourcePicker";
import "./theme/base.css";

const flowMediaResourcePort = await createTauriFlowMediaResourcePort();
const runtime = createViewerRuntime({
  scan: tauriMediaScanPort,
  sourcePicker: tauriSourcePickerPort,
  representation: tauriMediaRepresentationPort,
  resource: tauriMediaResourcePort,
  flowResource: flowMediaResourcePort,
  detail: tauriMediaDetailPort,
});

window.addEventListener("beforeunload", () => runtime.dispose(), { once: true });

mountViewerApp(runtime);
