# Thumbnail Cache Telemetry Baseline

> Status: incremental living baseline supplement
> Baseline date: 2026-09-13
> Baseline commit: `860b408b` (`feat(cache): add thumbnail cache telemetry snapshot`)
> Parent living status: [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)

This document records the runtime thumbnail-cache telemetry behavior added after the current `IMPLEMENTATION_STATUS.md` baseline. It is intentionally narrow and should be folded back into the main living status when that document is next updated through a safe whole-file edit.

## Runtime telemetry now available

The Tauri thumbnail cache manager now maintains a lightweight in-memory telemetry snapshot. The read-only `get_thumbnail_cache_telemetry` command exposes:

- generated backend cache registrations;
- reused backend cache registrations;
- currently active derived resource keys;
- currently active backend cache registrations/leases;
- successful cache-maintenance runs;
- cache-maintenance failures;
- cumulative evicted file count;
- cumulative evicted bytes;
- the cache size observed after the most recent successful maintenance run.

The counters are process-local runtime observations. They are not persisted across application restarts.

## Metric semantics

`generatedRegistrations` and `reusedRegistrations` count successful backend cache registrations, not frontend subscriber requests. The frontend representation scheduler can deduplicate multiple subscribers into one backend request, so these values must not be interpreted as raw UI request counts.

A generated registration means the expected thumbnail cache path did not exist before the production `ImageThumbnailer` pipeline ran. A reused registration means the expected cache path already existed and the production thumbnail path reused that derived file.

This provides an application-level cache-generation/reuse signal without changing scheduler, cache-key, eviction or representation-lifetime policy.

## Resource-lifetime observations

`activeResourceKeys` reports the number of derived thumbnail resource keys currently protected by the cache manager. `activeRegistrations` reports the sum of backend registrations across those keys, so a shared key can contribute more than one registration until its final release.

The counters therefore reflect the same explicit representation lifetime already used by the resource registry and cache protection logic. Querying telemetry does not acquire or release resources.

## Maintenance observations

Cache maintenance remains best-effort. A pruning error increments `maintenanceFailures`, returns the existing maintenance error to the caller, and continues to be handled by the representation path as a non-fatal cache optimization failure. Browsing behavior and representation delivery remain unchanged.

A successful maintenance pass increments `maintenanceRuns`, accumulates removed file/byte totals and records `afterBytes` as the latest observed cache size. This is not a continuous disk-usage monitor: the value changes only when the existing maintenance policy actually runs.

## Performance and architecture implications

The telemetry path does not scan the cache directory when queried. Snapshot creation locks the existing cache-manager state briefly and sums the in-memory active registration counts. Expensive filesystem work remains confined to the pre-existing maintenance path.

No new frontend polling, dashboard or always-on diagnostics loop has been introduced. Consumers may explicitly request a snapshot when diagnostics are needed.

The following remain out of scope and are still engineering debt:

- representative real-corpus benchmark result baselines;
- process memory telemetry;
- PixiJS/GPU texture or GPU-memory telemetry;
- end-to-end cache telemetry presentation/diagnostic UX;
- Playwright/Tauri end-to-end interaction tests;
- continuous disk usage accounting between maintenance passes.

## Tests and CI

Focused Tauri Rust tests cover generated versus reused registration counting, active registration changes across shared-resource release, maintenance snapshot state and idempotent release of unknown keys. The feature passed Tauri lockfile verification, rustfmt, Clippy, Rust tests and the integrated desktop smoke build before merge.
