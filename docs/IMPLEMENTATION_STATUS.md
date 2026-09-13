# WaterfallViewer Implementation Status

> Status: Living implementation baseline
> Architecture reference: [`ARCHITECTURE.md`](ARCHITECTURE.md) v0.3
> Baseline date: 2026-09-13
> Baseline commit: `e03d13e` (`feat(resources): add representation lease lifecycle`)

This document records what the repository actually implements today. `ARCHITECTURE.md` remains the design rationale and long-term direction; when proven implementation choices differ from the original sketch, this document is the source of truth for current behavior until the architecture document is revised.

## 1. Current product baseline

WaterfallViewer has moved well beyond Core Foundation. The current desktop baseline already implements the main local-media browsing pipeline:

```text
Local folder
  -> Rust recursive scan + metadata fast paths
  -> Tauri Channel batches
  -> frontend MediaSession / MediaIndex
  -> shared filter + stable deferred sort projection
  -> Masonry or Justified incremental layout
  -> virtualized DOM flow

Shared MediaSession
  -> Canvas scene model
  -> world coordinates + camera + spatial index + LOD
  -> bounded PixiJS render set

Opaque media resource protocol
  -> thumbnail request scheduler
  -> generated/cached representations
  -> explicit consumer leases
  -> Flow / Canvas resource release

Media activation
  -> image / animated image / video / audio preview
  -> previous / next navigation
```

The project is therefore best described as a **working desktop media-browsing core with validated Flow and Free Canvas architectures**, not as a foundation-only repository.

## 2. Phase status against `ARCHITECTURE.md`

| Phase | Status | Current reality |
| --- | --- | --- |
| A. Core Foundation | Complete | Independent `waterfall-core` / `waterfall-infra`, media/source/scan contracts, recursive scanner and tests exist. |
| B. Streaming Image Browser | Complete | Tauri Channel streaming, session replacement/cancellation, incremental Masonry/Justified layout, viewport virtualization and DOM browsing are implemented. |
| C. Resource Pipeline | Mostly complete | Thumbnail generation, opaque resource protocol, priority/deduplicating frontend scheduler, persistent visual metadata cache and explicit representation leases exist. Bounded thumbnail disk eviction and running-generation cancellation remain. |
| D. Free Canvas | Core complete | World-space scene, camera, spatial index, LOD policy, bounded viewport snapshots and PixiJS renderer are implemented and share the same media session/query as Flow. |
| E. Multimedia | Partial | Animated image, video and audio remain visible in browsing; explicit preview/playback exists; video dimensions have a container metadata fast path. Rich video/audio details, posters and covers remain. |
| F. Theme & Runtime Customization | Early | A small CSS-variable base exists, but formal token families, theme packs and optional visual-effect modules are not yet implemented. |
| G. Mobile Adapter | Not started | Core boundaries remain mobile-oriented, but mobile source adapters, touch input mapping and mobile resource budgets are not implemented. |

## 3. Validated architecture decisions

The following original architecture principles have held up in implementation and should remain invariants.

### 3.1 Rust core stays independent of Tauri

`crates/waterfall-core` and `crates/waterfall-infra` remain independently testable. Tauri owns application-shell and platform/IPC concerns rather than defining core media models.

### 3.2 Large media sets are streaming by default

Scanning emits batches instead of returning a complete media array. The frontend incrementally indexes, projects and lays out results, and both DOM and Pixi renderers operate on bounded visible/overscan sets.

### 3.3 Flow and Canvas use different renderers but share application state

Traditional flow uses virtualized DOM. Free Canvas uses PixiJS. They share the same source/session/query projection rather than performing duplicate scans or creating renderer-specific media models.

### 3.4 File paths are not frontend resource URLs

The frontend consumes opaque resource keys/URIs. Local filesystem paths remain behind Rust/Tauri platform boundaries. This remains important for security and eventual mobile adapters.

### 3.5 Resource lifetime is explicit

As of `e03d13e`, scheduled thumbnail results are consumer leases. Deduplicated subscribers share one backend registration; Flow and Canvas release leases when representations leave their render set, change size/LOD, become stale, or are disposed. The Tauri resource registry reference-counts derived registrations and removes the protocol mapping after the final release.

This lifetime layer deliberately does **not** delete the cached PNG. Disk persistence and live protocol registration are separate lifetimes.

## 4. Intentional deviations from the original sketch

These are not treated as regressions. They reflect implementation experience and should normally be documented rather than mechanically rewritten to match the earlier diagram.

### 4.1 Query/filter/sort is frontend application-core behavior

The original Rust-core sketch included `MediaQuery`, `SortRule`, `FilterRule` and a Rust `QueryMedia` use case. The current implementation keeps session-local filtering and sorting in TypeScript application code.

This is currently the preferred boundary because:

- the complete streamed item index is already present in the frontend;
- changing a view query does not require filesystem work;
- keeping projection local avoids unnecessary IPC round trips;
- Flow, Canvas and Viewer can share one projected index;
- large-dataset contracts already cover the performance-sensitive behavior.

Move query work to Rust only if future requirements introduce data volumes or query semantics that make the frontend index unsuitable.

### 4.2 `MediaSession` is logically unified but physically decomposed

`ARCHITECTURE.md` illustrated one large `MediaSession` object containing items, query, selection, viewer and view state. The implementation instead uses a small session/index plus dedicated workspace, query, viewer, Flow and Canvas controllers.

This decomposition is preferred: the user-visible session remains shared, while concerns do not accumulate in a monolithic state object.

### 4.3 The Rust application layer remains deliberately light

Scanning follows the Core/Port/Infrastructure/Tauri boundary strongly. Thumbnail representation generation is currently a small Tauri orchestration around the infrastructure thumbnail adapter and resource registry rather than a large Rust `RequestRepresentation` use-case hierarchy.

Do not add abstraction only for symmetry. Formalize a separate representation application service when cancellation, multiple representation kinds, cross-platform providers or policy composition make the boundary materially useful.

## 5. Current architecture debt and next priorities

The next work should continue to focus on media browsing and resource behavior rather than adding unrelated product complexity.

1. **Bounded thumbnail disk cache.** Add explicit capacity and eviction policy. Never evict a representation that has an active derived-resource registration. Eviction must be best-effort: cache-maintenance failure must not make media browsing fail.
2. **Cancellation of running thumbnail work.** Frontend subscribers can already cancel queued/shared interest, but once `spawn_blocking` image generation begins, the decode/resize operation currently runs to completion. Add cooperative cancellation when the representation pipeline is formalized enough to support it safely.
3. **Multimedia detail representations.** Add richer video/audio metadata and poster/cover generation without making full playback decoding part of scan-time work.
4. **Selection model.** Selection remains intentionally absent from the current browsing core even though it was present in the original session sketch.
5. **Input abstraction.** Desktop pointer/keyboard handling still reaches presentation/controller code directly. Introduce semantic `Pan`, `Zoom`, `Activate`, `Back`, `Next`, `Previous`, `Select` mapping before mobile work expands.
6. **Theme/effect boundary.** Replace remaining hard-coded presentation values with coherent design tokens, then add runtime themes/effects only after functional behavior is stable.
7. **Formal benchmarks and E2E.** Unit/contract coverage is broad and desktop release smoke builds run in CI, but the benchmark dataset/metrics harness and end-to-end interaction suite described in `ARCHITECTURE.md` are still missing.
8. **Mobile adapters.** Keep current ports platform-neutral; implement Android/iOS source/input/resource adapters only after desktop resource behavior is mature.

## 6. Performance contracts already established

The repository already embodies several performance rules from the architecture baseline:

- dimensions are read through metadata/header paths where possible rather than by full decode;
- media discovery is batched and streamed;
- the frontend maintains indexed media lookup rather than repeated linear activation searches;
- non-source sorting is deferred until scan termination to avoid repeated global re-sorts while batches arrive;
- flow creates only the visible/overscan DOM set;
- canvas queries a spatial index and uploads only bounded LOD-selected representations;
- representation scheduling is concurrency-bounded, priority-aware and deduplicated;
- visual metadata has bounded in-memory reuse plus a persistent SQLite cache;
- stale session and stale async representation results are ignored/released.

These are part of the architecture contract and should be protected by tests when changed.

## 7. Testing and CI baseline

Pull-request CI classifies changed paths and runs only the relevant jobs. Depending on the change set this includes:

- frontend Vitest + TypeScript/Vite build;
- independent Rust core/infrastructure fmt, Clippy and tests;
- Tauri lockfile verification, fmt, Clippy and tests;
- integrated desktop `tauri build --no-bundle --ci` smoke build.

The repository has extensive unit/contract coverage for scanning, metadata/cache behavior, query projection, Masonry/Justified layout, viewport virtualization, camera/spatial behavior, Canvas LOD/controller behavior, resource scheduling/leases, renderer texture lifetime, workspace sharing, media activation and preview navigation.

Still missing as formal engineering capabilities:

- reproducible `bench-data` and benchmark reports;
- Playwright/Tauri end-to-end interaction tests;
- explicit memory/GPU/cache-hit telemetry baselines.

## 8. Architecture rule for future changes

A future change should preserve this dependency intent:

```text
Presentation / Theme
        |
        v
Frontend Application + View Core
        |
        v
Frontend Ports
        |
        v
Tauri / Platform adapters
        |
        v
Rust application/core contracts
        ^
        |
Infrastructure adapters
```

The exact number of layers is less important than the boundary: **UI does not own filesystem/media work; renderers do not own media state; Rust core does not own Vue/Tauri concerns; caches remain disposable; expensive work remains bounded and progressively cancellable.**

When implementation experience shows that a proposed abstraction is unnecessary, update the documentation rather than adding complexity solely to satisfy an old diagram.
