# WaterfallViewer Implementation Status

> Status: Living implementation baseline
> Architecture reference: [`ARCHITECTURE.md`](ARCHITECTURE.md) v0.3
> Baseline date: 2026-09-13
> Baseline commit: `b135a964` (`ci(desktop): add Windows smoke build`)

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

Shared media selection
  -> session-scoped application controller
  -> survives filter/sort projection changes
  -> clears on source/session replacement
  -> Flow + Canvas selection chrome

Opaque media resource protocol
  -> priority/deduplicating thumbnail scheduler
  -> generated/cached representations
  -> explicit consumer leases
  -> cooperative backend cancellation after final consumer leaves
  -> bounded disk cache with active-resource protection
  -> Flow / Canvas resource release

Media activation
  -> image / animated image / video / audio preview
  -> previous / next navigation
  -> active video/audio detail request through opaque resource key
  -> stale-safe preview metadata state
  -> ISO-BMFF video/audio / WAV / ID3v2 / FLAC / Ogg Vorbis / Opus detail fast paths
  -> duration/codec plus supported audio title/artist display

Platform input
  -> desktop pointer/wheel/keyboard adapters
  -> touch tap/pan/pinch adapter for Free Canvas
  -> semantic Pan / Zoom / Activate / Select / Back / Previous / Next actions
  -> existing Canvas / Viewer application controllers

Presentation theme boundary
  -> semantic core palette tokens
  -> semantic status/danger tokens
  -> overlay/HUD/shadow/blur effect tokens
  -> Flow / Canvas / Preview consume theme values without owning palette constants

Performance and validation
  -> deterministic mixed-media synthetic fixtures
  -> 10k incremental Masonry / Justified / Canvas build benchmarks
  -> prepared 50k Flow / Canvas visibility-query benchmarks
  -> production real-filesystem scan/header-metadata benchmark entry point
  -> production active-media detail parser benchmark with per-format statistics
  -> production thumbnail generation/cache-reuse benchmark with per-format miss/hit statistics
  -> on-demand cache/request/resource/Canvas texture-lifetime telemetry
  -> deterministic Chromium Playwright main-flow E2E gate
  -> Linux + Windows integrated Tauri compile smoke gates
  -> large-dataset bounded-work contract tests remain the hard performance CI gate
```

The project is therefore best described as a **working desktop media browser in Desktop 1.0 validation/release preparation, with validated Flow and Free Canvas architectures, explicit resource lifetimes, semantic cross-input boundaries, concrete runtime telemetry, browser-level main-flow E2E, and repeatable performance evidence across in-memory, filesystem-scan, active-detail and thumbnail-generation/cache-reuse paths**, not as a foundation-only repository.

## 2. Phase status against `ARCHITECTURE.md`

| Phase | Status | Current reality |
| --- | --- | --- |
| A. Core Foundation | Complete | Independent `waterfall-core` / `waterfall-infra`, media/source/scan contracts, recursive scanner and tests exist. |
| B. Streaming Image Browser | Complete | Tauri Channel streaming, session replacement/cancellation, incremental Masonry/Justified layout, viewport virtualization and DOM browsing are implemented. |
| C. Resource Pipeline | Core complete | Thumbnail generation, opaque resource protocol, priority/deduplicating scheduler, persistent visual metadata cache, explicit representation leases, bounded thumbnail disk eviction and cooperative running-generation cancellation exist. Future representation kinds can reuse this lifecycle rather than requiring a new resource architecture. |
| D. Free Canvas | Core complete | World-space scene, camera, spatial index, LOD policy, bounded viewport snapshots and PixiJS renderer are implemented and share the same media session/query/selection as Flow. |
| E. Multimedia | Partial, materially advanced | Animated image, video and audio remain visible in browsing; explicit preview/playback exists; video dimensions have a container fast path. Video/audio details are loaded on demand outside the scan hot path. Current lightweight detail coverage includes ISO-BMFF video metadata, M4A/MP4-audio duration, audio sample-entry codec and iTunes-style title/artist text tags, WAV, ID3v2/MP3, FLAC STREAMINFO/Vorbis Comment, Ogg Vorbis and Opus metadata. Poster/cover representations and broader container/tag coverage remain. |
| F. Theme & Runtime Customization | Foundation established | Semantic palette/state/overlay/effect tokens now back the main Flow, Canvas and Preview visual surfaces. Runtime theme packs, user theme selection and optional effect modules are not yet implemented. |
| G. Mobile Adapter | In progress | Desktop semantic input exists and Free Canvas accepts touch tap, one-finger pan and two-finger pan/pinch through the same semantic actions. Mobile source/resource adapters, mobile resource budgets and broader mobile interaction/UI adaptation remain. |

## 3. Validated architecture decisions

### 3.1 Rust core stays independent of Tauri

`crates/waterfall-core` and `crates/waterfall-infra` remain independently testable. Tauri owns application-shell and platform/IPC concerns rather than defining core media models.

### 3.2 Large media sets are streaming by default

Scanning emits batches instead of returning a complete media array. The frontend incrementally indexes, projects and lays out results, and both DOM and Pixi renderers operate on bounded visible/overscan sets.

### 3.3 Flow and Canvas use different renderers but share application state

Traditional flow uses virtualized DOM. Free Canvas uses PixiJS. They share the same source/session/query projection and selection state rather than performing duplicate scans or creating renderer-specific media models.

### 3.4 File paths are not frontend resource URLs

The frontend consumes opaque resource keys/URIs. Local filesystem paths remain behind Rust/Tauri platform boundaries. This remains important for security and eventual mobile adapters.

### 3.5 Resource lifetime is explicit

As of `e03d13e`, scheduled thumbnail results are consumer leases. Deduplicated subscribers share one backend registration; Flow and Canvas release leases when representations leave their render set, change size/LOD, become stale, or are disposed. The Tauri resource registry reference-counts derived registrations and removes the protocol mapping after the final release.

Disk persistence and live protocol registration remain separate lifetimes. As of `f67b1ac`, the thumbnail disk cache has an explicit high-water/target pruning policy. Active representation registrations protect their backing files from eviction, recently published files receive a short race-safety grace period, and cache-maintenance failure degrades cache behavior rather than media browsing.

As of `ad07866`, the scheduler also owns backend-work interest. One shared consumer cancelling does not abort work still needed by another consumer; after the final consumer leaves, the scheduler aborts the backend request and removes that job from deduplication. The Tauri adapter carries cancellation through a request ID and bounded request registry to a platform-independent Rust cancellation token. Thumbnail generation observes cancellation between decode/resize/encode/write/publication stages, and late cancellation releases any derived registration created during the race.

This cancellation is intentionally cooperative. Third-party decode/resize/encode calls are not forcibly interrupted mid-call; cancellation is observed at the next safe pipeline boundary.

### 3.6 Rich multimedia metadata stays out of the scan hot path

As of `22121d8`, richer video/audio details are requested only for an explicitly active media item. The request crosses the existing opaque resource boundary and uses lightweight container/tag parsing instead of playback decoding.

As of `0d50666`, the lightweight fast paths include ISO-BMFF video duration/sample-entry codec, WAV duration/format, ID3v2 title/artist plus MP3 identification, and FLAC STREAMINFO duration/codec plus bounded Vorbis Comment title/artist parsing. FLAC metadata blocks are bounded/skipped rather than decoded, and this work remains on-demand rather than part of recursive scanning.

As of `1fb3226`, ISO-BMFF audio files such as M4A also use lightweight box parsing for movie duration and the `soun` track sample-entry codec (for example `mp4a` or `alac`). Video tracks are explicitly ignored when resolving an audio codec.

As of `d0c80c7`, the M4A/MP4-audio fast path also reads bounded iTunes-style text metadata from `moov/udta/meta/ilst`. `©nam` and `©ART` provide title and artist, UTF-8 and UTF-16BE `data` payloads are supported, and each text value is capped at 256 KiB. Unknown/non-text data types are ignored without disturbing duration/codec metadata. Embedded artwork (`covr`) remains intentionally deferred rather than turning the active-media detail path into a representation pipeline.

As of `196ee90`, Ogg Vorbis and Opus details are also parsed without decoding audio frames. Header/tag packet traversal is bounded; Vorbis duration uses the final granule position and identification-header sample rate, while Opus duration applies the RFC pre-skip rule at 48 kHz. The final granule is located from a bounded tail window instead of linearly scanning the full media payload. Vorbis Comments / OpusTags provide supported title and artist values.

As of `ba9cb6e`, `PreviewMediaDetailController` observes activation as a sidecar rather than turning navigation into asynchronous state. It rejects stale results after rapid previous/next navigation and degrades metadata failures without affecting media playback. Image and animated-image activation does not trigger this detail I/O.

### 3.7 Platform input is translated before application behavior

As of `b74b176`, desktop free-canvas drag/wheel/double-click input and preview keyboard navigation are translated by `src/platform/input` adapters into platform-neutral actions before reaching application behavior. Presentation owns DOM event hookup and DOM-native-control detection, but not drag delta semantics, wheel zoom scaling or preview key meaning.

As of `5eb2887`, Canvas primary-click selection also flows through this contract as `Select` with explicit `replace` / `toggle` semantics. Dragging and middle-button navigation do not accidentally select.

As of `c39a814`, touch input follows the same boundary. `TouchCanvasInputAdapter` maps a stationary one-finger tap to `Select`, one-finger movement to `Pan`, and a two-contact gesture to midpoint `Pan` plus anchored `Zoom`. Pinch/cancelled/moved gestures cannot synthesize a tap selection. `CanvasBrowserController`, camera/scene models, selection state and Pixi renderer remain unaware of touch-specific concepts.

### 3.8 Performance numbers and performance invariants are separate tools

As of `9a056cc`, the repository has a reproducible synthetic benchmark harness for the hot in-memory layout/query paths. Deterministic mixed-media fixtures are streamed in 64-item batches, matching the application data path closely enough to compare algorithmic changes without requiring a real filesystem corpus.

The synthetic suite measures 10,000-item incremental Masonry, Justified and Canvas scene/index construction plus prepared 50,000-item Masonry and Canvas visibility queries. It is run explicitly with `pnpm bench`; benchmark sources are type-checked by the regular frontend build so they cannot silently drift from application APIs.

As of `f031bb3`, a release-mode Rust example also benchmarks the production `LocalFilesystemScanner` against a caller-supplied media corpus. It exercises recursive traversal, media classification and the same scan-time header visual-metadata reads used by the application, reporting per-run counts, warnings, throughput and min/median/max timings. Repeated measured runs are checked for stable scan summaries so changes to the source corpus are visible instead of silently contaminating comparisons.

As of `db8a4a6`, a second release-mode Rust example benchmarks the production `read_media_detail` dispatch path over real audio/video candidates. Corpus discovery happens outside the timed region; measured files are grouped by extension and each run reports detailed/unsupported/error counts, aggregate throughput and per-format medians. This deliberately includes the same dispatch/fallback behavior used by active preview metadata rather than timing format parsers in isolation.

As of `e64dbda`, a third release-mode Rust example benchmarks the production `ImageThumbnailer` over real image and animated-image candidates. Corpus discovery and benchmark-cache cleanup happen outside the timed regions. Each measured run uses an isolated temporary cache: the miss phase exercises source decode, resize, PNG encode and atomic publication, while the immediate hit phase reuses the generated PNG and reads its dimensions without decoding the source again. Results include per-format and aggregate median timings, throughput, unsupported/error counts and generated cache size. The benchmark deliberately avoids exporting Tauri-private cache-key, resource-registration or eviction policy solely for measurement, so it validates the expensive thumbnail pipeline and existing-file reuse path rather than claiming to measure the complete desktop cache manager.

Synthetic, scanner, detail-parser and thumbnail-pipeline latency are intentionally **not** absolute GitHub-hosted-runner merge gates. Shared-runner timing is too noisy, while real-corpus measurements additionally depend on storage, file mix and OS cache state. The thumbnail benchmark controls application-level destination state with a fresh temporary cache for each measured run, but it intentionally does not normalize OS/filesystem caches. Before/after measurements should be compared on the same machine under comparable power, thermal and cache conditions, with multiple runs and medians. `tests/largeDatasetContracts.test.ts` remains the CI enforcement layer for bounded frontend work such as visible/render-set sizes and representation-request counts.

### 3.9 Selection is shared application state, not renderer state

As of `5eb2887`, `MediaSelectionController` owns session-scoped selection independently of Flow and Canvas. It supports replace and toggle semantics plus a deterministic primary item. A source/session replacement clears selection; query, filter and sort projection changes within the same session do not.

Flow and Canvas translate interaction into selection operations and render lightweight selection chrome. The Canvas scene model, layout models, Pixi renderer and representation scheduler do not own selection. This keeps selection orthogonal to resource lifetime and rendering strategy and allows future commands or mobile input to consume the same state.

### 3.10 Theme tokens describe reusable visual meaning, not component geometry

As of `7a4c37a`, `src/theme/base.css` defines semantic token groups for the core palette, status/danger states and overlay/effect surfaces. Flow placeholders, Canvas HUD/error chrome and Preview overlays/navigation consume those variables rather than embedding their own palette/effect constants.

The token boundary is intentionally narrower than a full design system. Theme variables express reusable visual meaning such as `danger-surface` or `floating-surface`; they do not absorb view-specific widths, gaps, media-query breakpoints or geometry merely to remove numeric literals. Runtime theme packs can later override the semantic values without changing layout or application behavior.

### 3.11 Runtime diagnostics observe existing lifecycles rather than creating new ones

Cache/request telemetry, the media-resource registry snapshot, and Canvas texture-lease telemetry are all read-only views over existing runtime state. They do not add hot-path polling, duplicate ownership registries or filesystem scans. Cache generated/reused registration counts provide an application-level cache reuse signal; request/resource/texture counts make cancellation and lease convergence observable. These values are diagnostic lifecycle signals, not process-memory or GPU/VRAM measurements.

### 3.12 Browser E2E and desktop smoke builds validate different boundaries

The deterministic `e2e.html` fixture mounts the real Vue presentation over the production `createViewerRuntime(...)` controller graph while substituting deterministic platform ports. Playwright therefore validates the main presentation/application workflow without duplicating the production graph.

Linux and Windows `pnpm tauri build --no-bundle --ci` jobs validate integrated desktop compilation on both platform families. They do not validate native picker interaction, real packaged WebView protocol behavior, installer creation or installed-app startup. Those remain separate acceptance concerns rather than reasons to weaken the browser fixture boundary.

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

`ARCHITECTURE.md` illustrated one large `MediaSession` object containing items, query, selection, viewer and view state. The implementation instead uses a small session/index plus dedicated workspace, query, selection, viewer, Flow and Canvas controllers.

This decomposition is preferred: the user-visible session remains shared, while concerns do not accumulate in a monolithic state object.

### 4.3 The Rust representation application layer remains deliberately light

Scanning follows the Core/Port/Infrastructure/Tauri boundary strongly. Representation work has a real lifecycle spanning the frontend scheduler, Tauri request/registration registries and platform-independent infrastructure cancellation/cache primitives, but it still does not require a heavyweight Rust `RequestRepresentation` use-case hierarchy.

Cancellation alone did not justify adding abstraction for symmetry. Formalize a separate representation application service when multiple representation kinds, cross-platform providers, policy composition or richer derived-media dependencies make that boundary materially useful.

## 5. Current architecture debt and next priorities

The resource pipeline's core lifecycle is closed for image thumbnails; multimedia metadata covers several common audio/video formats; desktop and touch Canvas input share a semantic boundary; shared selection is concrete; runtime diagnostics make the major representation lifetimes observable; browser main-flow E2E is merge-gated; and Linux/Windows integrated desktop compilation is validated. The project is now primarily closing release/acceptance gaps rather than filling foundational architecture gaps.

1. **Windows release-candidate packaging and release workflow.** Move beyond `--no-bundle` smoke builds by producing inspectable Windows bundle artifacts on an explicit release-candidate workflow. Keep unsigned CI packages distinct from signed production distribution, and do not invent signing infrastructure before keys/policy exist.
2. **Native desktop acceptance.** Validate source picking, recursive traversal/permissions, Tauri Channel/command behavior, `waterfall-media` delivery including Range/HEAD playback, packaged startup, and long-session lifecycle convergence. Automate where practical; use an explicit acceptance checklist where GUI automation would be disproportionate.
3. **Representative performance/telemetry baselines.** The benchmark tools and runtime telemetry exist; what remains is a controlled representative corpus/report baseline, process-memory observations where useful, and long-session convergence evidence. True GPU/VRAM measurement remains optional diagnostic debt rather than a Desktop 1.0 blocker unless a real issue demands it.
4. **Poster/cover representations and broader multimedia coverage when justified.** Generate low-cost audio cover/video poster representations through the existing lifecycle only when an implementation fits the current dependency budget. Do not introduce a heavyweight video decoder merely to satisfy the old architecture sketch.
5. **Product/release polish.** Finalize product/window metadata, versioning, installer/release notes and acceptance documentation. Runtime theme packs, bulk file-management actions and broader mobile UI are not prerequisites for the current desktop browser.
6. **Broader mobile interaction and platform adapters later.** Free Canvas touch navigation is implemented, but preview gestures/controls, source/resource adapters, mobile budgets and layout decisions require explicit platform work after desktop behavior is mature.

## 6. Performance contracts already established

The repository embodies several performance rules from the architecture baseline:

- dimensions are read through metadata/header paths where possible rather than by full decode;
- richer video/audio details are loaded only for active media and never added to recursive scan-time work;
- FLAC detail parsing bounds comment buffering and skips unrelated metadata blocks rather than decoding media payloads;
- ISO-BMFF audio detail parsing walks bounded box structures, selects the audio track without decoding media payloads, and caps individual iTunes-style text tag values at 256 KiB;
- Ogg detail parsing bounds header pages and packet buffering, and obtains duration from a bounded file-tail window rather than scanning the complete audio payload;
- stale async multimedia detail results cannot overwrite a newly activated preview;
- media discovery is batched and streamed;
- the frontend maintains indexed media lookup rather than repeated linear activation searches;
- non-source sorting is deferred until scan termination to avoid repeated global re-sorts while batches arrive;
- flow creates only the visible/overscan DOM set;
- canvas queries a spatial index and uploads only bounded LOD-selected representations;
- representation scheduling is concurrency-bounded, priority-aware and deduplicated;
- a backend representation request is cooperatively cancelled after its final consumer leaves, while shared work remains alive for retained consumers;
- orphaned non-cooperative work cannot be rejoined by a later consumer and its eventual derived registration is released;
- visual metadata has bounded in-memory reuse plus a persistent SQLite cache;
- thumbnail disk persistence has an explicit bounded pruning policy and protects actively registered representations;
- stale session and stale async representation results are ignored/released;
- selection chrome is bounded by the already bounded visible Flow/Canvas item sets and does not expand representation work;
- touch gesture translation performs only constant-size contact bookkeeping and does not change scene/query complexity;
- runtime telemetry is read on demand from existing bounded registries/pools and does not add continuous hot-path polling;
- deterministic 10k/50k layout and visibility-query benchmarks provide reproducible before/after evidence without turning noisy hosted-runner milliseconds into false precision;
- the production filesystem scanner, active-media detail dispatch and `ImageThumbnailer` miss/generation versus existing-file reuse paths have repeatable release-mode real-corpus benchmarks, but their timings remain local comparative evidence rather than machine-independent CI thresholds.

These are part of the architecture contract and should be protected by tests when changed.

## 7. Testing and CI baseline

Pull-request CI classifies changed paths and runs only the relevant jobs. Depending on the change set this includes:

- frontend Vitest scoped to `tests/` plus TypeScript/Vite build;
- deterministic Chromium Playwright main-flow E2E for frontend-affecting changes;
- independent Rust core/infrastructure fmt, Clippy and tests;
- Tauri lockfile verification, fmt, Clippy and tests;
- integrated Linux desktop `tauri build --no-bundle --ci` smoke build;
- integrated Windows/MSVC desktop `tauri build --no-bundle --ci` smoke build.

The repository has extensive unit/contract coverage for scanning, metadata/cache behavior, query projection, Masonry/Justified layout, viewport virtualization, camera/spatial behavior, Canvas LOD/controller behavior, resource scheduling/leases/cancellation, renderer texture lifetime, workspace sharing, media activation/navigation, on-demand multimedia detail parsing, stale-safe preview detail loading, shared selection lifecycle and semantic input mapping.

FLAC parser tests cover STREAMINFO duration/codec, Vorbis Comment title/artist, non-FLAC input and malformed/truncated metadata. ISO-BMFF audio parser tests cover M4A-style duration/audio codec extraction, UTF-8 and UTF-16BE iTunes-style title/artist tags, ignored non-text tag payloads, rejection of video tracks as audio codec sources and non-ISO input. Ogg tests cover Vorbis duration/comments, Opus pre-skip duration and OpusTags, non-Ogg input and invalid pre-skip/granule combinations. Selection tests cover replace/toggle behavior, primary selection, source/session invalidation, preservation across query projection changes and rejection of missing media. Desktop input tests cover click-to-select semantics and ensure drag/middle-button gestures do not accidentally select. Touch input tests cover tap selection, single-contact pan, two-contact midpoint pan/pinch, pinch-to-single-contact continuation, cancellation and contact-count bounds.

A deterministic in-memory benchmark harness covers the major layout/query hot paths. `pnpm bench` runs streamed 10k construction/index benchmarks and prepared 50k visibility-query benchmarks, while normal frontend build type-checks the benchmark source. Release-mode `waterfall-infra` examples run the production filesystem scanner, production `read_media_detail` dispatcher and production `ImageThumbnailer` against caller-supplied corpora, reporting repeated scan/header-metadata measurements, overall/per-format active-detail timings and parser result counts, and isolated thumbnail generation versus existing-file reuse timings. Large-dataset contract tests remain the merge-gating performance assertions; machine-dependent real-corpus latency remains comparative evidence rather than a CI threshold.

Runtime telemetry now covers thumbnail generated/reused registrations and maintenance state, thumbnail request cancellation convergence, source/derived media-resource registrations, and Canvas texture lease/ref/unloading convergence. Browser E2E covers the deterministic main viewer workflow over the real production frontend runtime graph. Linux and Windows smoke builds prove integrated desktop compilation on their respective targets.

Still missing as formal engineering capabilities:

- representative benchmark corpus/report acceptance baselines and long-session convergence reports;
- native Tauri/WebView interaction validation for real picker/filesystem/IPC/custom-protocol behavior;
- bundled installer/package artifact validation and installed-app startup acceptance;
- process-memory telemetry and, only if decision-useful, true GPU/VRAM allocation diagnostics;
- end-user diagnostic UX or continuous disk-usage accounting between maintenance passes.

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

The exact number of layers is less important than the boundary: **UI does not own filesystem/media work; renderers do not own media state; Rust core does not own Vue/Tauri concerns; caches remain disposable; expensive work remains bounded and progressively cancellable; platform input becomes semantic before it reaches application behavior.**

When implementation experience shows that a proposed abstraction is unnecessary, update the documentation rather than adding complexity solely to satisfy an old diagram.
