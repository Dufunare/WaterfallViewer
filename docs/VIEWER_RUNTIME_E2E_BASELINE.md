# Viewer Runtime and E2E Foundation Baseline

> Status: incremental living baseline supplement
> Baseline date: 2026-09-13
> Baseline commit: `1e8ebdf7` (`refactor(bootstrap): extract viewer runtime composition`)
> Parent living status: [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)

This document records the application-composition seam established before introducing browser or desktop end-to-end automation.

## Production composition is now explicit

`src/bootstrap/viewerRuntime.ts` owns the production frontend controller graph through `createViewerRuntime(...)`. The factory receives platform ports rather than importing Tauri adapters itself:

- media scan;
- source picker;
- derived-media representation;
- media resource URI resolution;
- active-media detail metadata.

The factory constructs the shared `MediaSessionController`, query and selection controllers, representation scheduler, workspace, activation/detail controllers, Flow browser, and the shared Canvas scene used by remounted Canvas browser controllers.

`src/main.ts` is now a thin platform composition root: it supplies the real Tauri adapters, marks controller instances as raw for Vue, mounts `App.vue`, and delegates shutdown cleanup to the runtime.

## Runtime lifecycle

`ViewerRuntime.dispose()` preserves the previous shutdown order for the long-lived controllers and is idempotent. Canvas browser instances remain owned by the presentation component that creates them, matching the pre-existing mount/unmount lifecycle rather than moving view-local ownership into the application runtime.

The shared Canvas scene remains inside the runtime factory so Canvas controller remounts preserve the same camera/world state without starting another scan session.

## Test seam

The existing shared-viewer integration test now constructs the application through `createViewerRuntime` using fake implementations of the same platform port interfaces. The test no longer duplicates the production controller wiring.

It verifies that a single source pick and scan session feed:

- workspace state;
- query projection;
- Flow browsing;
- Canvas browsing;
- a remounted Canvas controller that retains the shared scene/camera state.

This keeps the production composition authoritative while allowing deterministic platform substitutes in tests.

## What this does not claim

This is an **E2E/bootstrap foundation**, not a completed end-to-end test system.

There is currently no Playwright dependency, browser-launch test suite, WebDriver/Tauri desktop automation, or test-only alternate application mode. The runtime factory does not contain environment checks or fake behavior.

A later browser fixture can supply deterministic ports to the same runtime factory and exercise real Vue presentation behavior. Native Tauri integration still requires its own desktop-level automation or smoke coverage because browser tests cannot validate file-dialog, custom protocol, filesystem, or native IPC behavior.

## Next engineering steps

The next E2E work should remain layered:

1. provide a deterministic browser-facing bootstrap that uses the real `createViewerRuntime` and fake platform ports without changing production `main.ts` behavior;
2. add Playwright only when that fixture can exercise meaningful user workflows such as opening a seeded source, switching Flow/Canvas, activating media, navigating preview, filtering/sorting, and selection;
3. retain the existing Tauri desktop smoke build and add native desktop automation separately when it becomes reliable enough to justify CI cost.

Do not treat browser E2E as proof of Tauri filesystem/IPC correctness, and do not duplicate the controller graph inside test code.

## CI baseline

The composition refactor passed the complete frontend Vitest suite and TypeScript/Vite build. The shared-session integration test uses the same runtime factory as production and validates shared session/scene behavior after the refactor.
