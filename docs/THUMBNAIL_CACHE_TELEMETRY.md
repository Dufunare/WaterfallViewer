# Thumbnail and Media Resource Runtime Telemetry Baseline

> Status: incremental living baseline supplement
> Baseline date: 2026-09-13
> Cache telemetry baseline: `860b408b` (`feat(cache): add thumbnail cache telemetry snapshot`)
> Request telemetry baseline: `b94ea0bf` (`feat(telemetry): add thumbnail request runtime snapshot`)
> Media resource telemetry baseline: `1fb9ad10` (`feat(telemetry): add media resource registry snapshot`)
> Parent living status: [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)

This document records the runtime cache/request/resource telemetry behavior added after the current `IMPLEMENTATION_STATUS.md` baseline. It is intentionally narrow and should be folded back into the main living status when that document is next updated through a safe whole-file edit.

## Runtime cache telemetry

The Tauri thumbnail cache manager maintains a lightweight in-memory telemetry snapshot. The read-only `get_thumbnail_cache_telemetry` command exposes:

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

### Cache metric semantics

`generatedRegistrations` and `reusedRegistrations` count successful backend cache registrations, not frontend subscriber requests. The frontend representation scheduler can deduplicate multiple subscribers into one backend request, so these values must not be interpreted as raw UI request counts.

A generated registration means the expected thumbnail cache path did not exist before the production `ImageThumbnailer` pipeline ran. A reused registration means the expected cache path already existed and the production thumbnail path reused that derived file.

This provides an application-level cache-generation/reuse signal without changing scheduler, cache-key, eviction or representation-lifetime policy.

### Cache resource-lifetime observations

`activeResourceKeys` reports the number of derived thumbnail resource keys currently protected by the cache manager. `activeRegistrations` reports the sum of backend registrations across those keys, so a shared key can contribute more than one registration until its final release.

The counters therefore reflect the same explicit representation lifetime already used by the resource registry and cache protection logic. Querying telemetry does not acquire or release resources.

### Maintenance observations

Cache maintenance remains best-effort. A pruning error increments `maintenanceFailures`, returns the existing maintenance error to the caller, and continues to be handled by the representation path as a non-fatal cache optimization failure. Browsing behavior and representation delivery remain unchanged.

A successful maintenance pass increments `maintenanceRuns`, accumulates removed file/byte totals and records `afterBytes` as the latest observed cache size. This is not a continuous disk-usage monitor: the value changes only when the existing maintenance policy actually runs.

## Runtime request telemetry

The thumbnail request registry exposes a lightweight in-memory snapshot through the read-only `get_thumbnail_request_telemetry` command:

- `activeRequests`: backend thumbnail requests that have registered and have not yet finished;
- `cancelledActiveRequests`: active requests whose cooperative cancellation token is already cancelled but whose backend task has not yet reached `finish`;
- `pendingCancellations`: bounded pre-cancellation tombstones for cancellation commands that raced ahead of request registration.

These values observe request-registry convergence. They do not count frontend scheduler subscribers and do not change request priority, deduplication or cancellation behavior.

### Cancellation semantics

An active request remains included in `activeRequests` after cancellation until its backend request reaches the existing finish path. During that interval it is also included in `cancelledActiveRequests`. A healthy cancellation lifecycle should therefore allow cancelled-active counts to return toward zero as cooperative work reaches a cancellation boundary and finishes.

If cancellation arrives before the Tauri request invocation has registered its request ID, the ID is retained as a bounded pre-cancellation tombstone. Registration consumes that tombstone and starts with an already-cancelled token, moving the observation from `pendingCancellations` to the active/cancelled-active state until finish.

The existing bound of 256 pending cancellation IDs remains unchanged. Telemetry exposes the current set size but does not add retention or history beyond the pre-existing bounded registry.

## Runtime media-resource telemetry

The active `MediaResourceRegistry` now exposes an on-demand snapshot through the read-only `get_media_resource_telemetry` command:

- `activeSession`: whether a current resource generation exists;
- `generation`: the opaque resource generation currently represented by the registry;
- `sourceResourceKeys`: source-file resource keys registered in the current generation;
- `derivedResourceKeys`: unique deduplicated derived-resource keys in the current generation;
- `derivedRegistrations`: total reference-counted registrations across those derived keys;
- `totalResourceKeys`: source plus unique derived keys currently resolvable by the media protocol.

The snapshot is computed directly from the registry's real `paths` and `derived_keys` state. It does not maintain a second mutable counter system, expose filesystem paths or scan the filesystem.

### Resource-generation and convergence semantics

`activeSession` means that the media resource registry has a current generation. It does **not** mean that recursive scanning is still running. A completed scan intentionally leaves its generation active so discovered media can continue to resolve through the `waterfall-media` protocol.

Starting a new source session replaces the previous generation and resets all current resource counts for the new generation. Old opaque resource keys remain invalid through the existing generation checks.

`derivedResourceKeys` and `derivedRegistrations` are intentionally separate. If multiple backend registrations share the same derived path, one deduplicated resource key can have more than one registration. Releasing one registration decreases `derivedRegistrations` while keeping the key resolvable; the final release removes that derived key from both the registration index and the protocol path table. This makes leaked or non-converging derived-resource lifetimes observable without changing their lifecycle policy.

## Performance and architecture implications

None of the telemetry commands performs a filesystem scan. Cache snapshot creation locks the existing cache-manager state briefly and sums in-memory active registrations. Request snapshot creation locks the request registry briefly and inspects the currently active cancellation tokens. Media-resource snapshot creation locks the resource registry briefly and derives counts from its current in-memory maps.

No frontend polling, dashboard or always-on diagnostics loop has been introduced. Consumers may explicitly request snapshots when diagnostics are needed. Normal browsing, resource registration, cancellation, URI resolution and cache-maintenance policy remain unchanged.

The following remain out of scope and are still engineering debt:

- representative real-corpus benchmark result baselines;
- process memory telemetry;
- PixiJS/GPU texture or GPU-memory telemetry;
- end-to-end telemetry presentation/diagnostic UX;
- Playwright/Tauri end-to-end interaction tests;
- continuous disk usage accounting between maintenance passes.

## Tests and CI

Focused Tauri Rust tests cover generated versus reused cache registration counting, active cache registration changes across shared-resource release, maintenance snapshot state and idempotent release of unknown keys.

Request-registry tests cover active cancellation visibility, cancellation-before-registration transfer from a pending tombstone to an already-cancelled active token, convergence to zero after `finish`, duplicate request-ID rejection and the existing pending-cancellation bound.

Media-resource tests cover source/derived key counting, shared derived-registration reference counts, convergence after partial and final release, and reset to a fresh generation when a new source session begins. Existing generation invalidation, URI range handling and MIME behavior remain covered by their pre-existing tests.

All three telemetry slices passed Tauri lockfile verification, rustfmt, Clippy, Rust tests and the integrated desktop smoke build before merge.
