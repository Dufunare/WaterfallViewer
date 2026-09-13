# WaterfallViewer Benchmarks

This directory contains reproducible performance benchmarks for layout/query hot paths plus real-corpus Rust benchmark entry points for filesystem scanning, active-media detail parsing and thumbnail generation/cache reuse.

## Synthetic in-memory benchmarks

Run the deterministic layout/query suite with:

```bash
pnpm bench
```

Benchmark files use Vitest's benchmark project and are intentionally excluded from the normal `pnpm test` run. The regular frontend `pnpm build` still type-checks `benchmarks/**/*.ts`, so benchmark source cannot silently drift out of sync with application APIs.

The benchmark fixtures generate deterministic mixed-media datasets. Every 20 items contain one video, one audio item, one animated image, and seventeen still images. Items are streamed into the models in batches of 64 to mirror the application's incremental data path.

The current suite measures:

- 10,000-item incremental Masonry layout construction;
- 10,000-item incremental Justified layout construction;
- 10,000-item Canvas scene construction and spatial indexing;
- prepared 50,000-item Masonry viewport queries;
- prepared 50,000-item Canvas spatial queries.

## Real-filesystem scan benchmark

A Rust example exercises the production `LocalFilesystemScanner`, including recursive discovery, media classification and scan-time header visual metadata reads against a representative local corpus:

```bash
cargo run --release -p waterfall-infra --example scan_bench -- <media-root> --runs 5 --warmups 1 --batch-size 64
```

The command prints per-run elapsed time, discovered/accepted media counts, emitted batches, warnings, accepted-items throughput, and min/median/max summary values. Measured runs are checked for stable scan counts so a changing source directory is visible in the report.

## Active-media detail parser benchmark

A second Rust example measures the production `read_media_detail` path over recognized audio/video files. Corpus discovery and grouping happen before timing, so the measured region focuses on the lightweight container/tag parsers used when the user activates media:

```bash
cargo run --release -p waterfall-infra --example media_detail_bench -- <media-root> --runs 5 --warmups 1
```

Files are grouped by extension before each measured pass. The command reports overall run time and throughput, then per-format median timings with counts for successfully parsed details, unsupported/undetailed files and parser errors. Measured runs are checked for stable parser-result counts so source/readability changes are visible.

This benchmark intentionally includes the real production dispatch path rather than calling individual format parsers directly. A corpus may therefore contain formats that WaterfallViewer classifies as audio/video but for which rich detail support is partial or absent; those appear as `unsupported` or `errors` instead of being silently excluded.

## Thumbnail pipeline and cache-reuse benchmark

A third Rust example measures the production `ImageThumbnailer` over recognized image/animated-image files:

```bash
cargo run --release -p waterfall-infra --example thumbnail_bench -- <media-root> --runs 5 --warmups 1 --max-edge 256
```

Each measured run uses a fresh temporary cache directory. Corpus discovery and cache cleanup happen outside the timed regions. The benchmark then performs two explicit phases per extension group:

- **miss/generation:** the destination does not exist, so the production path decodes the source, resizes it, encodes PNG, and publishes it with the same atomic-write helper used by the app;
- **hit/reuse:** the same destination already exists, so the production path reuses the PNG and reads its dimensions without decoding the source again.

The command reports per-run and per-format miss/hit timings, generated/reused counts, unsupported/error counts, miss/hit throughput, and generated cache size. Measured runs are checked for stable result counts so changes to source readability or codec coverage are visible.

This benchmark deliberately exercises `ImageThumbnailer` directly instead of exporting Tauri's private resource-registration or cache-key helpers just for measurement. It therefore measures the expensive production thumbnail pipeline and its existing-file reuse path without coupling `waterfall-infra` to desktop-only resource lifecycle policy. Cache eviction/lease maintenance remains a separate concern.

## Corpus and comparison guidance

The real-corpus benchmarks intentionally do **not** try to defeat or normalize operating-system/filesystem caches. Record whether a result represents a cold-ish first pass or warmed repeated passes, and compare revisions under the same cache/power/thermal conditions. They are not CI latency gates because real filesystem performance is machine- and corpus-dependent.

For useful corpus results, prefer a directory with a realistic mixture of image, animated image, video and audio files, nested directories, varied file sizes, and enough items to expose traversal and metadata overhead. For detail-parser comparisons, include representative MP4/M4A/WAV/MP3/FLAC/Ogg/Opus files plus other classified audio/video formats to make unsupported coverage visible. For thumbnail comparisons, include representative JPEG/PNG/GIF/WebP/BMP/TIFF sources at varied resolutions and file sizes; classified formats unsupported by the current thumbnail decoder remain visible as unsupported results instead of being silently dropped. Do not commit private or copyrighted benchmark media to the repository; keep representative `bench-data` external or locally generated.

For useful before/after measurements:

1. Run both revisions on the same machine.
2. Keep the power mode and thermal state comparable.
3. Close avoidable background workloads.
4. Run each revision at least three times.
5. Compare medians rather than a single run.
6. Use the same corpus and comparable cache state for real-filesystem measurements.

GitHub-hosted shared runners are intentionally **not** used as a latency merge gate because their machine allocation and contention are not stable enough for meaningful absolute thresholds.

`tests/largeDatasetContracts.test.ts` remains the enforcement layer for work-bounded frontend behavior. It verifies limits such as visible/render-set size and representation-request counts on large datasets, while benchmarks provide quantitative performance evidence for optimization work.

## Remaining benchmark work

The repository now has deterministic in-memory layout/query coverage plus repeatable production-path benchmarks for filesystem scanning, active-media detail parsing, and thumbnail miss/generation versus existing-cache reuse. Further benchmark work should focus on representative corpus/report baselines, cache eviction/maintenance behavior where justified, plus explicit memory/GPU/cache telemetry and end-to-end interaction measurements. These should remain locally reproducible evidence unless a future runner provides sufficiently stable hardware for meaningful thresholds.
