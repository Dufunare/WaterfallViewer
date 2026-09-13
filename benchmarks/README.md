# WaterfallViewer Benchmarks

This directory contains reproducible synthetic benchmarks for layout and visibility-query hot paths.

Run them with:

```bash
pnpm bench
```

Benchmark files use Vitest's benchmark project and are intentionally excluded from the normal `pnpm test` run. The regular frontend `pnpm build` still type-checks `benchmarks/**/*.ts`, so benchmark source cannot silently drift out of sync with application APIs.

## Current benchmark set

The benchmark fixtures generate deterministic mixed-media datasets. Every 20 items contain one video, one audio item, one animated image, and seventeen still images. Items are streamed into the models in batches of 64 to mirror the application's incremental data path.

The current suite measures:

- 10,000-item incremental Masonry layout construction;
- 10,000-item incremental Justified layout construction;
- 10,000-item Canvas scene construction and spatial indexing;
- prepared 50,000-item Masonry viewport queries;
- prepared 50,000-item Canvas spatial queries.

## Comparing results

Benchmark timings are intended for relative comparison, not as an absolute CI gate. For useful before/after measurements:

1. Run both revisions on the same machine.
2. Keep the power mode and thermal state comparable.
3. Close avoidable background workloads.
4. Run each revision at least three times.
5. Compare medians rather than a single run.

GitHub-hosted shared runners are intentionally **not** used as a latency merge gate because their machine allocation and contention are not stable enough for meaningful absolute thresholds.

`tests/largeDatasetContracts.test.ts` remains the enforcement layer for work-bounded behavior. It verifies limits such as visible/render-set size and representation-request counts on large datasets, while the benchmarks provide quantitative performance evidence for optimization work.

## Remaining benchmark work

This suite is deliberately focused on deterministic in-memory layout and query paths. Separate representative `bench-data` is still needed for real filesystem scanning, metadata parsing, thumbnail decode/resize/encode, disk-cache hit/miss behavior, memory usage, and renderer/GPU telemetry.
