# Viewer Runtime and E2E Foundation Baseline

> Status: incremental living baseline supplement
> Baseline date: 2026-09-13
> Runtime composition baseline: `1e8ebdf7` (`refactor(bootstrap): extract viewer runtime composition`)
> Deterministic browser fixture baseline: `0b08d3cf` (`test(e2e): add deterministic browser fixture`)
> Playwright browser E2E baseline: `eace87b1` (`test(e2e): add Playwright desktop main-flow coverage`)
> Parent living status: [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)

This document records the application-composition seam, deterministic browser fixture, and browser-level end-to-end coverage used to validate the desktop viewer main flow without duplicating production application wiring.

## Production composition is explicit

`src/bootstrap/viewerRuntime.ts` owns the production frontend controller graph through `createViewerRuntime(...)`. The factory receives platform ports rather than importing Tauri adapters itself:

- media scan;
- source picker;
- derived-media representation;
- media resource URI resolution;
- active-media detail metadata.

The factory constructs the shared `MediaSessionController`, query and selection controllers, representation scheduler, workspace, activation/detail controllers, Flow browser, and the shared Canvas scene used by remounted Canvas browser controllers.

`src/bootstrap/mountViewerApp.ts` owns the common Vue root wiring. Production `src/main.ts` supplies the real Tauri ports, creates the runtime, registers shutdown cleanup and mounts `App.vue` through this shared helper.

## Runtime lifecycle

`ViewerRuntime.dispose()` preserves the existing shutdown order for long-lived controllers and is idempotent. Canvas browser instances remain owned by the presentation component that creates them, matching the mount/unmount lifecycle rather than moving view-local ownership into the application runtime.

The shared Canvas scene remains inside the runtime factory so Canvas controller remounts preserve the same camera/world state without starting another scan session.

## Deterministic browser fixture

The repository contains a browser-facing fixture entry at `e2e.html`.

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

## Browser E2E coverage

`playwright.config.ts` launches the Vite fixture on a fixed loopback port and runs the browser suite in Chromium. `e2e/viewer-main-flow.spec.ts` exercises the real Vue presentation mounted over the production runtime graph.

The current browser E2E gate covers:

- opening the deterministic source;
- observing the source name, completed scan state and total media count;
- switching Columns, Rows and Canvas viewer modes;
- filtering to video/audio and restoring the all-media projection;
- changing sort order and observing the projected first item;
- selecting an image in Flow;
- activating image preview and navigating to the next item;
- closing preview through semantic desktop input;
- activating the seeded video and validating duration/codec metadata presentation;
- activating the seeded audio and validating duration/codec/title/artist presentation.

The test prefers semantic roles, accessible names and existing view labels where possible rather than coupling the main workflow to renderer implementation details.

Vitest is explicitly scoped to `tests/` so unit/integration suites and Playwright suites have separate discovery boundaries.

## CI behavior

Frontend-affecting changes now run both:

- the existing Frontend job: frozen pnpm install, Vitest and TypeScript/Vite build;
- the Browser E2E job: frozen application install, pinned Playwright 1.63.0 Chromium setup and the deterministic browser workflow.

Playwright remains a CI-only pinned test tool in this baseline rather than a checked-in pnpm devDependency. The application dependency install still uses `pnpm install --frozen-lockfile`; the E2E job installs the pinned Playwright tool into an isolated `.playwright-tools` prefix and links only the test package into the job-local `node_modules` for test-module resolution. This avoids hand-editing `pnpm-lock.yaml` or weakening frozen-lockfile validation.

On browser-test failure, Playwright trace/screenshot output under `test-results` is uploaded as a short-retention CI artifact. Local Playwright tool/output directories are ignored by Git.

The first merged browser-E2E slice passed Frontend, Browser E2E, Rust core, Tauri Rust and the integrated desktop smoke build in one CI run.

## Existing shared-session integration coverage

The shared-viewer integration test also constructs the application through `createViewerRuntime` using fake implementations of the same platform port interfaces. It verifies that a single source pick and scan session feed:

- workspace state;
- query projection;
- Flow browsing;
- Canvas browsing;
- a remounted Canvas controller that retains the shared scene/camera state.

Together, these tests keep the production composition authoritative while allowing deterministic platform substitutes in tests.

## What this does not claim

Browser E2E is now a real merge gate, but it still does **not** validate the native Tauri boundary.

The deterministic browser suite cannot prove:

- native directory-picker behavior;
- real recursive filesystem traversal and permissions;
- Tauri Channel/command serialization;
- the `waterfall-media` custom protocol and HTTP Range behavior inside the desktop WebView;
- packaged desktop application startup and installer behavior.

The existing desktop smoke build verifies that the integrated application compiles, but it is not interactive native automation.

## Next engineering steps toward desktop 1.0

The next E2E/release work should remain layered:

1. keep the deterministic browser main-flow suite as the fast presentation/application regression gate and extend it only when a concrete desktop workflow requires coverage;
2. add native desktop-level validation for source picking, real filesystem scanning, custom-protocol delivery and packaged-app startup without pretending browser E2E proves those paths;
3. add representative real-corpus acceptance baselines using the existing scan/detail/thumbnail benchmark tools and runtime telemetry before declaring desktop 1.0 performance-ready;
4. establish a release/bundle workflow and final Windows acceptance checklist once native behavior and performance baselines are stable.

Do not duplicate the controller graph inside native or browser tests, and do not move expensive native-media behavior into the deterministic browser fixture solely to make it look more production-like.
