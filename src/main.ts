import { mountViewerApp } from "./bootstrap/mountViewerApp";
import { createViewerRuntime } from "./bootstrap/viewerRuntime";
import { tauriMediaDetailPort } from "./platform/tauri/mediaDetail";
import { tauriMediaRepresentationPort } from "./platform/tauri/mediaRepresentation";
import { createTauriMediaResourcePort } from "./platform/tauri/mediaResource";
import { tauriMediaScanPort } from "./platform/tauri/mediaScan";
import { tauriSourcePickerPort } from "./platform/tauri/sourcePicker";
import "./theme/base.css";

const mediaResourcePort = await createTauriMediaResourcePort();
const runtime = createViewerRuntime({
  scan: tauriMediaScanPort,
  sourcePicker: tauriSourcePickerPort,
  representation: tauriMediaRepresentationPort,
  resource: mediaResourcePort,
  detail: tauriMediaDetailPort,
});

window.addEventListener("beforeunload", () => runtime.dispose(), { once: true });

mountViewerApp(runtime);
