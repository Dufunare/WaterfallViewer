# Viewer Runtime and E2E Foundation Baseline

> Status: incremental living baseline supplement
> Baseline date: 2026-09-13
> Runtime composition baseline: `1e8ebdf7` (`refactor(bootstrap): extract viewer runtime composition`)
> Deterministic browser fixture baseline: `0b08d3cf` (`test(e2e): add deterministic browser fixture`)
> Playwright browser E2E baseline: `eace87b1` (`test(e2e): add Playwright desktop main-flow coverage`)
> Windows desktop smoke baseline: `b135a964` (`ci(desktop): add Windows smoke build`)
> Parent living status: [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)

This document records the application-composition seam, deterministic browser fixture, browser-level end-to-end coverage, and current integrated desktop build gates used to validate the desktop viewer without duplicating production application wiring.

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

Frontend-affecting changes run both:

- the Frontend job: frozen pnpm install, Vitest and TypeScript/Vite build;
- the Browser E2E job: frozen application install, pinned Playwright 1.63.0 Chromium setup and the deterministic browser workflow.

Playwright remains a CI-only pinned test tool in this baseline rather than a checked-in pnpm devDependency. The application dependency install still uses `pnpm install --frozen-lockfile`; the E2E job installs the pinned Playwright tool into an isolated `.playwright-tools` prefix and links only the test package into the job-local `node_modules` for test-module resolution. This avoids hand-editing `pnpm-lock.yaml` or weakening frozen-lockfile validation.

On browser-test failure, Playwright trace/screenshot output under `test-results` is uploaded as a short-retention CI artifact. Local Playwright tool/output directories are ignored by Git.

Tauri-affecting changes also run integrated `pnpm tauri build --no-bundle --ci` smoke builds on both Linux and Windows. The Windows gate runs on `windows-latest` with the stable Rust/MSVC toolchain and the same frozen frontend dependency install. This proves that the integrated application compiles on the primary Windows desktop target in addition to Linux; it does not create or execute an installer.

The Playwright slice passed Frontend, Browser E2E, Rust core, Tauri Rust and Linux desktop smoke in one CI run. The Windows-smoke slice subsequently passed the complete matrix including the new Windows integrated build.

## Existing shared-session integration coverage

The shared-viewer integration test also constructs the application through `createViewerRuntime` using fake implementations of the same platform port interfaces. It verifies that a single source pick and scan session feed:

- workspace state;
- query projection;
- Flow browsing;
- Canvas browsing;
- a remounted Canvas controller that retains the shared scene/camera state.

Together, these tests keep the production composition authoritative while allowing deterministic platform substitutes in tests.

## What this does not claim

Browser E2E is a real merge gate, and Linux/Windows smoke builds prove integrated compilation, but neither layer validates native interactive behavior.

The current automated suite does not yet prove:

- native directory-picker behavior;
- real recursive filesystem traversal and permissions inside the packaged desktop application;
- Tauri Channel/command serialization under an interactive WebView session;
- the `waterfall-media` custom protocol and HTTP Range behavior inside the desktop WebView;
- installer creation, installation, upgrade/uninstall behavior, signing, or packaged-app startup after installation.

The smoke builds intentionally use `--no-bundle`; they are compile/integration gates, not release-package validation.

## Next engineering steps toward desktop 1.0

The remaining E2E/release work should stay layered:

1. keep the deterministic browser main-flow suite as the fast presentation/application regression gate and extend it only when a concrete desktop workflow requires coverage;
2. establish a Windows bundle/release-candidate workflow that produces inspectable package artifacts without conflating unsigned CI packages with signed production releases;
3. add native desktop-level validation for source picking, real filesystem scanning, custom-protocol delivery and packaged-app startup, using automation where practical and an explicit acceptance checklist where runner limitations make GUI automation disproportionate;
4. add representative real-corpus acceptance baselines using the existing scan/detail/thumbnail benchmark tools and runtime telemetry before declaring desktop 1.0 performance-ready.

Do not duplicate the controller graph inside native or browser tests, and do not move expensive native-media behavior into the deterministic browser fixture solely to make it look more production-like.
