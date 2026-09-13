# Viewer Runtime and E2E Foundation Baseline

> Status: incremental living baseline supplement
> Baseline date: 2026-09-13
> Runtime composition baseline: `1e8ebdf7` (`refactor(bootstrap): extract viewer runtime composition`)
> Deterministic browser fixture baseline: `0b08d3cf` (`test(e2e): add deterministic browser fixture`)
> Parent living status: [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)

This document records the application-composition seam and deterministic browser fixture established before adding full browser or desktop end-to-end automation.

## Production composition is explicit

`src/bootstrap/viewerRuntime.ts` owns the production frontend controller graph through `createViewerRuntime(...)`. The factory receives platform ports rather than importing Tauri adapters itself:

- media scan;
- source picker;
- derived-media representation;
- media resource URI resolution;
- active-media detail metadata.

The factory constructs the shared `MediaSessionController`, query and selection controllers, representation scheduler, workspace, activation/detail controllers, Flow browser, and the shared Canvas scene used by remounted Canvas browser controllers.

`src/bootstrap/mountViewerApp.ts` now owns the common Vue root wiring. Production `src/main.ts` supplies the real Tauri ports, creates the runtime, registers shutdown cleanup and mounts `App.vue` through this shared helper.

## Runtime lifecycle

`ViewerRuntime.dispose()` preserves the existing shutdown order for long-lived controllers and is idempotent. Canvas browser instances remain owned by the presentation component that creates them, matching the mount/unmount lifecycle rather than moving view-local ownership into the application runtime.

The shared Canvas scene remains inside the runtime factory so Canvas controller remounts preserve the same camera/world state without starting another scan session.

## Deterministic browser fixture

The repository now contains a browser-facing fixture entry at `e2e.html`.

`src/testing/seededBrowserMain.ts` mounts the real `App.vue` through the same `mountViewerApp(...)` helper used by production. `src/testing/seededBrowserRuntime.ts` creates the real `ViewerRuntime` and substitutes only deterministic platform ports.

The seeded fixture provides:

- one deterministic source named `Seeded Browser Gallery`;
- six media items split across two scan batches;
- four images, one video and one audio item;
- deterministic thumbnail representations backed by generated SVG data URIs;
- deterministic video and audio detail metadata;
- deterministic session IDs.

The fixture does not add a production environment switch or test-mode conditional to `src/main.ts`.

A focused Vitest integration test validates that the seeded ports drive the real runtime graph through source opening, scan completion, query filtering, activation and video/audio detail loading before browser automation is layered on top.

## Existing shared-session integration coverage

The shared-viewer integration test also constructs the application through `createViewerRuntime` using fake implementations of the same platform port interfaces. It verifies that a single source pick and scan session feed:

- workspace state;
- query projection;
- Flow browsing;
- Canvas browsing;
- a remounted Canvas controller that retains the shared scene/camera state.

Together, these tests keep the production composition authoritative while allowing deterministic platform substitutes in tests.

## What this does not claim

This remains an **E2E foundation**, not a completed end-to-end test system.

There is still no Playwright dependency or browser-launch interaction suite, and no WebDriver/Tauri native desktop automation. The deterministic browser fixture exercises the real Vue presentation and application runtime, but browser automation cannot validate native file-dialog behavior, filesystem traversal, Tauri IPC, or the `waterfall-media` custom protocol.

## Next engineering steps toward desktop 1.0

The E2E work should now proceed in layers:

1. add Playwright against `e2e.html` and cover the main deterministic browsing workflow: open source, wait for scan completion, switch Columns/Rows/Canvas, filter/sort, select/activate media and navigate/close preview;
2. keep browser E2E focused on presentation/application behavior and avoid duplicating runtime composition inside tests;
3. retain the current Tauri desktop smoke build and add native desktop-level validation separately for source picking, filesystem scanning, custom-protocol media delivery and packaged application behavior.

Do not treat browser E2E as proof of Tauri filesystem/IPC correctness.

## CI baseline

The deterministic browser fixture slice passed the complete frontend Vitest suite and TypeScript/Vite build before merge. Rust/Tauri jobs were correctly skipped because the slice changed only frontend/test paths.
