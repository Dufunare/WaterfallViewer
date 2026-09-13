# Desktop 1.0 Native Acceptance

> Status: release-readiness acceptance protocol
> Primary target: Windows x64 / Tauri 2 / WebView2
> Scope: behavior that browser E2E and compile-only smoke builds cannot prove

This document defines the evidence required before WaterfallViewer can claim a Desktop 1.0 release candidate is functionally acceptable on Windows. It intentionally separates automated gates from interactive checks instead of pretending that browser automation proves native platform behavior.

## 1. Required build evidence

A candidate must first pass the repository's ordinary CI and the explicit Windows Release Candidate workflow.

Required evidence:

- frontend Vitest and TypeScript/Vite build pass;
- deterministic Chromium main-flow Playwright E2E passes;
- Rust core/infrastructure tests and Clippy pass;
- Tauri Rust tests and Clippy pass;
- Linux and Windows integrated `tauri build --no-bundle --ci` smoke builds pass;
- Windows x64 NSIS bundle is produced by `.github/workflows/windows-release-candidate.yml`;
- exactly one `*-setup.exe` is present;
- `SHA256SUMS.txt` is produced and matches the installer;
- the CI package is explicitly treated as unsigned unless signing infrastructure is later configured;
- the release executable passes the native startup smoke once that gate is merged.

Failure of any item above blocks acceptance. Do not waive a failing automated gate through a manual checklist.

## 2. Test corpus

Use a real local directory tree rather than the deterministic browser fixture. The corpus should contain at minimum:

- nested directories at least three levels deep;
- PNG and JPEG images with mixed aspect ratios;
- at least one animated image supported by the current scanner;
- at least one MP4/M4A-family media file;
- at least one MP3, FLAC, WAV, Ogg Vorbis or Opus audio file;
- a non-media file that must be ignored;
- at least one filename containing spaces and non-ASCII characters;
- enough media to require scrolling/virtualization rather than fitting in one viewport.

For performance/long-session acceptance, use a second representative corpus large enough to create sustained scrolling, Canvas pan/zoom and thumbnail churn. Record corpus item counts and storage type when comparing runs.

## 3. Packaged startup and shutdown

Install or launch the exact release-candidate artifact being accepted.

Pass criteria:

- the application opens without an immediate crash or blank native window;
- the primary window title and application identity are coherent;
- the first interactive frame appears without requiring developer tools;
- closing the window terminates the application normally;
- a second launch after normal shutdown behaves the same way;
- no stale background process remains after normal close.

The automated native startup smoke only proves that the release executable remains alive during its smoke interval. It does not replace these interactive checks.

## 4. Native source picker and filesystem traversal

Open the test corpus using the real native source-picker path.

Pass criteria:

- the picker opens from the production application, not a browser fixture;
- selecting a directory starts one browsing session;
- nested media files are discovered recursively;
- unsupported/non-media files do not become media items;
- media appears incrementally while scanning rather than only after complete traversal;
- final item count is consistent with the corpus;
- opening a different source replaces the previous session without duplicating old items;
- cancelling or closing the picker does not corrupt the existing session;
- an inaccessible/unreadable entry degrades to a warning/error path without terminating the application.

This section is the primary acceptance evidence for native dialog permissions, Rust filesystem traversal and Tauri Channel delivery inside the real WebView session.

## 5. Flow view acceptance

Using the real corpus:

- switch between the implemented Flow layout modes;
- scroll rapidly in both directions;
- change media-kind filters;
- change sort order;
- select visible items;
- activate an item into Preview and return to Flow.

Pass criteria:

- no duplicate or permanently missing media appears after scan completion;
- layout remains stable after dimensions become known;
- rapid scrolling does not create unbounded DOM growth;
- filtering/sorting does not start another filesystem scan;
- selection follows the documented shared-session semantics;
- returning from Preview preserves a usable browsing state.

## 6. Free Canvas acceptance

Switch to Canvas after loading the same session.

Pass criteria:

- Canvas uses the already loaded source/session rather than rescanning;
- pan and zoom remain responsive across repeated large movements;
- LOD/thumbnail changes do not leave persistent stale textures;
- selection remains shared with Flow;
- switching Flow -> Canvas -> Flow does not duplicate session state;
- repeated Canvas mount/unmount cycles preserve the intended shared camera/world behavior and do not cause visible resource growth without convergence.

Where runtime texture/resource telemetry is available, capture snapshots before stress, during churn and after returning to a stable viewport.

## 7. Opaque media protocol and Preview acceptance

Activate image, video and audio items through the packaged application.

Pass criteria:

- media is loaded through the production opaque media-resource boundary rather than direct filesystem URLs exposed to the frontend;
- image preview displays correctly;
- video/audio playback starts for supported files;
- seeking in a sufficiently long video/audio file works after initial playback;
- repeated seek/back/forward operations do not break playback;
- previous/next navigation works across supported media;
- closing Preview releases the active presentation state and returns to browsing;
- supported video/audio metadata appears without blocking directory scanning.

Successful seek behavior is practical end-to-end evidence that Range delivery works through the WebView path. Existing Rust tests remain the precise protocol-level evidence for HEAD/Range semantics; native acceptance proves the packaged integration path.

## 8. Session replacement and stale-work rejection

During active thumbnail/detail work, replace the source with another directory.

Pass criteria:

- items from the old session do not reappear after the new source is active;
- late thumbnail/detail results from the old generation are ignored/released;
- Preview does not update with metadata from a previously active media item;
- the new session remains fully interactive while old work converges.

Use runtime resource/request telemetry to confirm old-generation registrations and requests converge rather than accumulating indefinitely.

## 9. Long-session resource convergence

On the representative large corpus, perform sustained browsing:

- rapid Flow scrolling;
- repeated Flow/Canvas switching;
- repeated Canvas pan/zoom across distant regions;
- opening and closing many previews;
- repeated filter/sort changes;
- at least one source replacement.

Record runtime telemetry at three points: initial steady state, peak churn, and post-churn steady state.

Pass criteria:

- visible/rendered work remains bounded by existing architecture contracts;
- thumbnail request counts converge after interaction stops;
- derived media-resource registrations converge after consumers leave;
- Canvas texture lease/ref/unloading counts converge after the viewport stabilizes;
- no obvious monotonic growth remains across repeated equivalent cycles.

Process memory may be recorded as supporting evidence, but allocator/WebView caching means exact return-to-baseline memory is not required without a demonstrated leak.

## 10. Installer lifecycle

For a release candidate intended for distribution, validate the NSIS artifact itself.

Pass criteria:

- installer starts on a clean Windows user environment compatible with the target baseline;
- installation completes without requiring repository/development files;
- installed application launches successfully;
- a reinstall/upgrade over the same version does not corrupt the application;
- uninstall removes the installed application entry and binaries expected to be owned by the package;
- user media files are never modified or removed by uninstall;
- unsigned CI packages are not described as production-signed releases.

When signing is introduced, signature verification becomes a separate mandatory release gate.

## 11. Acceptance record

For each candidate, record:

- commit SHA;
- workflow run IDs for ordinary CI and Windows Release Candidate;
- installer artifact name and SHA-256;
- Windows version and WebView2 runtime version used for interactive acceptance;
- test corpus summary;
- pass/fail result for sections 3-10;
- benchmark/telemetry snapshots used for the long-session check;
- links to any defects discovered.

A candidate is Desktop 1.0 acceptable only when all automated gates pass and all applicable native sections are recorded as passing. Any skipped section must be explicitly justified in the acceptance record rather than silently omitted.

## 12. What this protocol does not require

Desktop 1.0 acceptance does not require:

- mobile source adapters;
- runtime theme packs;
- video poster generation;
- audio cover extraction;
- exact GPU/VRAM allocation telemetry;
- broad file-management features.

Those remain future product work unless a concrete release blocker makes one necessary.
