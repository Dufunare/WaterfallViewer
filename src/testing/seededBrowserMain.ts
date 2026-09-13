import { mountViewerApp } from "../bootstrap/mountViewerApp";
import "../theme/base.css";
import { createSeededBrowserRuntime } from "./seededBrowserRuntime";

const runtime = createSeededBrowserRuntime();
const app = mountViewerApp(runtime);

document.documentElement.dataset.waterfallFixture = "seeded";

window.addEventListener(
  "beforeunload",
  () => {
    app.unmount();
    runtime.dispose();
  },
  { once: true },
);
