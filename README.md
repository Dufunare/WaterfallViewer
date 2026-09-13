# WaterfallViewer

![CI](https://github.com/Dufunare/WaterfallViewer/actions/workflows/ci.yml/badge.svg)

WaterfallViewer is a local-first, session-oriented multimedia browser for recursively exploring media stored across directory trees. The project targets high-performance traditional waterfall/justified browsing and a free-form infinite canvas while keeping media functionality independent from visual presentation.

## Architecture and implementation status

The long-term architecture and design rationale are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

The repository's current, validated implementation baseline and known architecture debt are tracked separately in [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md). Runtime telemetry and viewer/E2E evolution are recorded in [`docs/THUMBNAIL_CACHE_TELEMETRY.md`](docs/THUMBNAIL_CACHE_TELEMETRY.md) and [`docs/VIEWER_RUNTIME_E2E_BASELINE.md`](docs/VIEWER_RUNTIME_E2E_BASELINE.md). Desktop 1.0 native release acceptance is defined in [`docs/DESKTOP_ACCEPTANCE.md`](docs/DESKTOP_ACCEPTANCE.md), with a reusable candidate record in [`docs/DESKTOP_ACCEPTANCE_RECORD_TEMPLATE.md`](docs/DESKTOP_ACCEPTANCE_RECORD_TEMPLATE.md). Real-corpus performance evidence is documented in [`docs/REAL_CORPUS_BASELINE.md`](docs/REAL_CORPUS_BASELINE.md).

The Rust foundation remains intentionally split from Tauri:

- `crates/waterfall-core`: platform-independent media/source/scan contracts and ports.
- `crates/waterfall-infra`: filesystem scanning, metadata adapters/cache and thumbnail generation.
- `src-tauri`: desktop/mobile shell, IPC/platform integration and opaque media-resource protocol.
- `src`: Vue presentation, frontend application state, query/view controllers, layout/view core, renderers and theme foundation.

## Current capabilities

The current desktop baseline includes:

- recursive local-directory scanning with batched Tauri Channel delivery and cancellation;
- image, animated-image, video and audio discovery;
- metadata/header fast paths, including lightweight on-demand video/audio detail parsing;
- reusable in-memory and persistent SQLite visual-metadata caching;
- shared media indexing, media-kind filtering and stable deferred sorting;
- incremental Masonry and Justified flow layouts with viewport virtualization;
- a Free Canvas with world coordinates, camera, spatial indexing, LOD and a bounded PixiJS renderer;
- one shared source/session/query/selection model across Flow and Canvas;
- an opaque local-media protocol with Range/HEAD support;
- priority-aware, concurrency-bounded and deduplicated thumbnail scheduling;
- explicit reference-counted representation leases, cooperative cancellation and bounded thumbnail disk eviction;
- single-item image/video/audio preview/playback with adjacent navigation and supported audio metadata display;
- semantic desktop input plus touch pan/pinch/tap handling for Free Canvas;
- semantic theme tokens for the main Flow, Canvas and Preview surfaces;
- deterministic 10k/50k frontend benchmarks plus real-corpus scan/detail/thumbnail benchmark entry points;
- a PowerShell real-corpus baseline runner that captures environment metadata and raw production-path benchmark evidence without turning machine-dependent timings into CI thresholds;
- read-only runtime telemetry for thumbnail cache/request state, media-resource registrations and Canvas texture leases;
- deterministic Chromium Playwright coverage for the main browser-facing viewer workflow;
- selective CI with Linux and Windows integrated Tauri `--no-bundle` smoke builds plus Windows PowerShell script syntax validation;
- an explicit Windows x64 NSIS release-candidate workflow with SHA-256 artifact verification;
- native release-executable startup smoke on a Windows runner;
- automated NSIS package lifecycle smoke covering silent install to an isolated directory, installed-path startup, silent uninstall and removal of the installed application binary.

## Development

Frontend:

```bash
pnpm install
pnpm test
pnpm build
pnpm tauri dev
```

Rust core/infrastructure:

```bash
cargo test --manifest-path crates/Cargo.toml --workspace
cargo clippy --manifest-path crates/Cargo.toml --workspace --all-targets -- -D warnings
```

Tauri shell:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
```

Integrated desktop compile smoke:

```bash
pnpm tauri build --no-bundle --ci
```

Representative real-corpus capture on Windows/PowerShell:

```powershell
./scripts/run-real-corpus-baseline.ps1 -MediaRoot "D:\Media\AcceptanceCorpus"
```

The browser E2E suite uses `e2e.html` and a deterministic seeded platform fixture while preserving the production `createViewerRuntime(...)` composition. CI currently installs the pinned Playwright test tool separately from the frozen application dependency graph; see [`docs/VIEWER_RUNTIME_E2E_BASELINE.md`](docs/VIEWER_RUNTIME_E2E_BASELINE.md) for the exact boundary.

## Current development focus

WaterfallViewer is now in **Desktop 1.0 native validation and release preparation**, not core-foundation development. The difficult browsing architecture paths—streaming discovery, virtualized Flow, bounded Free Canvas rendering, explicit resource lifetimes, multimedia preview, shared selection/input, telemetry, browser main-flow E2E, Windows release-candidate packaging, direct native startup and installed-package lifecycle smoke—are already established.

The highest-value remaining desktop work is to:

1. complete interactive native acceptance that headless/build automation still cannot prove, especially the real directory picker, recursive traversal/permissions through the packaged WebView session, Tauri Channel/custom-protocol media delivery and seek behavior, normal GUI shutdown and second launch;
2. capture representative real-corpus benchmark evidence and long-session runtime-telemetry convergence on a controlled local corpus using the repository's acceptance record rather than inventing hosted-runner timing thresholds;
3. finish release policy work that requires explicit product decisions or external credentials, especially versioning/release notes, upgrade acceptance and code signing when keys/policy are available;
4. extend multimedia representation coverage only where it provides concrete product value without destabilizing the current resource pipeline.

Poster/cover generation, runtime theme packs, deep GPU/VRAM telemetry and mobile adapters remain valid future work, but they are not prerequisites for proving the current desktop browsing core. In particular, the project should not add a heavyweight video decoder solely to manufacture poster thumbnails for architectural symmetry.
