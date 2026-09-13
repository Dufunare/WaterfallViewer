import { createApp, markRaw } from "vue";

import App from "../App.vue";
import type { ViewerRuntime } from "./viewerRuntime";

export function mountViewerApp(
  runtime: ViewerRuntime,
  target: string | Element = "#app",
) {
  const app = createApp(App, {
    workspace: markRaw(runtime.workspace),
    query: markRaw(runtime.query),
    selection: markRaw(runtime.selection),
    flowBrowser: markRaw(runtime.flowBrowser),
    createCanvasBrowser: runtime.createCanvasBrowser,
    activation: markRaw(runtime.activation),
    previewDetails: markRaw(runtime.previewDetails),
  });
  app.mount(target);
  return app;
}
