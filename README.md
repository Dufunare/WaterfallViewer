# WaterfallViewer

![CI](https://github.com/Dufunare/WaterfallViewer/actions/workflows/ci.yml/badge.svg)

WaterfallViewer is a local-first, session-oriented multimedia browser for recursively exploring media stored across directory trees. The project targets high-performance traditional waterfall/justified browsing and a free-form infinite canvas while keeping media functionality independent from visual presentation.

## Architecture and implementation status

The long-term architecture and design rationale are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

The repository's current, validated implementation baseline and known architecture debt are tracked separately in [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md). When the original architecture sketch and proven implementation choices differ, the implementation-status document records the current behavior and rationale.

The Rust foundation remains intentionally split from Tauri:

- `crates/waterfall-core`: platform-independent media/source/scan contracts and ports.
- `crates/waterfall-infra`: filesystem scanning, metadata adapters/cache and thumbnail generation.
- `src-tauri`: desktop/mobile shell, IPC/platform integration and opaque media-resource protocol.
- `src`: Vue presentation, frontend application state, query/view controllers, layout/view core, renderers and theme foundation.

## Current capabilities

The current desktop baseline includes:

- recursive local-directory scanning with batched Tauri Channel delivery and cancellation;
- image, animated-image, video and audio discovery;
- metadata/header fast paths, including video visual dimensions;
- reusable in-memory and persistent SQLite visual-metadata caching;
- shared media indexing, media-kind filtering and stable deferred sorting;
- incremental Masonry and Justified flow layouts with viewport virtualization;
- a Free Canvas with world coordinates, camera, spatial indexing, LOD and a bounded PixiJS renderer;
- one shared source/session/query across Flow and Canvas;
- an opaque local-media protocol with range/HEAD support;
- priority-aware, concurrency-bounded and deduplicated thumbnail scheduling;
- explicit reference-counted representation leases and release from Flow/Canvas lifecycles;
- single-item image/video/audio preview/playback with adjacent navigation;
- selective CI plus an integrated desktop release smoke build.

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

Integrated desktop build:

```bash
pnpm tauri build --no-bundle --ci
```

## Current development focus

The project is now at a **working desktop media-browsing core** rather than Core Foundation. Flow and Free Canvas have both validated their main technical paths, and the resource pipeline is largely operational.

The next priorities are to close remaining resource-lifecycle gaps, beginning with a bounded thumbnail disk cache, then deepen multimedia metadata/representations and add formal benchmark/E2E coverage. Theme packs, semantic input abstraction and mobile adapters remain later phases rather than prerequisites for the current browsing core.
