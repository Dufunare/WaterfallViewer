import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const nativeE2ERoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(nativeE2ERoot, "..");
const application = path.join(root, "src-tauri", "target", "debug", "waterfallviewer");

let tauriDriver;
let shuttingDown = false;

export const config = {
  host: "127.0.0.1",
  port: 4444,
  specs: [path.join(nativeE2ERoot, "specs", "**", "*.spec.mjs")],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      "tauri:options": {
        application,
      },
    },
  ],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
  },
  waitforTimeout: 15_000,

  beforeSession() {
    tauriDriver = spawn(path.join(os.homedir(), ".cargo", "bin", "tauri-driver"), [], {
      stdio: ["ignore", "inherit", "inherit"],
    });

    tauriDriver.on("error", (error) => {
      console.error("tauri-driver error:", error);
      process.exitCode = 1;
    });

    tauriDriver.on("exit", (code) => {
      if (!shuttingDown && code !== 0) {
        console.error(`tauri-driver exited unexpectedly with code ${code}`);
        process.exitCode = 1;
      }
    });
  },

  afterSession() {
    closeTauriDriver();
  },
};

function closeTauriDriver() {
  shuttingDown = true;
  tauriDriver?.kill();
  tauriDriver = undefined;
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    closeTauriDriver();
    process.exit(1);
  });
}
