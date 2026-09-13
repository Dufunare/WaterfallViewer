# Desktop 1.0 Acceptance Record

> Candidate commit: `<sha>`
> Acceptance date: `<YYYY-MM-DD>`
> Result: `PASS | FAIL | INCOMPLETE`

Use this record together with [`DESKTOP_ACCEPTANCE.md`](DESKTOP_ACCEPTANCE.md). Do not mark the candidate accepted unless all mandatory automated gates pass and all applicable interactive sections are recorded as passing.

## 1. Automated build evidence

| Evidence | Run / artifact | Result | Notes |
| --- | --- | --- | --- |
| Ordinary CI | `<workflow run URL / ID>` | `PASS / FAIL` | |
| Windows Release Candidate | `<workflow run URL / ID>` | `PASS / FAIL` | |
| NSIS artifact | `<artifact name>` | `PASS / FAIL` | |
| Installer SHA-256 | `<sha256>` | `PASS / FAIL` | |
| Direct release executable startup smoke | `<run / step>` | `PASS / FAIL` | |
| Installed-package lifecycle smoke | `<run / step>` | `PASS / FAIL` | |

Unsigned CI artifacts must be identified as unsigned. Do not treat CI packaging success as evidence of production signing.

## 2. Acceptance environment

- Windows edition/version/build: `<value>`
- Architecture: `x64`
- WebView2 runtime version: `<value>`
- Storage type for primary corpus: `<SSD/HDD/network/etc.>`
- Display scale / resolution if relevant: `<value>`
- Installation mode/path used for interactive acceptance: `<value>`

## 3. Test corpus

### Functional corpus

- Root path or corpus identifier: `<value>`
- Total media items expected: `<count>`
- Directory depth: `<value>`
- Image formats/counts: `<value>`
- Animated formats/counts: `<value>`
- Video formats/counts: `<value>`
- Audio formats/counts: `<value>`
- Non-media files included: `<value>`
- Spaces/non-ASCII filenames included: `YES / NO`
- Known unreadable/inaccessible entry included: `YES / NO`

### Large / long-session corpus

- Corpus identifier: `<value>`
- Total media items: `<count>`
- Approximate total size: `<value>`
- Storage type: `<value>`
- Any material differences from previous baseline: `<value>`

## 4. Packaged startup and shutdown

Result: `PASS / FAIL`

- [ ] Installed/native window opens without immediate crash.
- [ ] First interactive frame is visible and usable.
- [ ] Product/window identity is correct.
- [ ] Normal window close terminates the application.
- [ ] Second launch succeeds.
- [ ] No stale process remains after normal close.

Evidence / notes:

`<notes>`

## 5. Native source picker and filesystem traversal

Result: `PASS / FAIL`

- [ ] Production native directory picker opens.
- [ ] Cancelling picker preserves the current session.
- [ ] Selecting the functional corpus starts one session.
- [ ] Nested directories are discovered recursively.
- [ ] Media appears incrementally during scanning.
- [ ] Final item count matches the corpus expectation.
- [ ] Non-media files are ignored.
- [ ] Spaces/non-ASCII filenames work.
- [ ] Source replacement does not leave old items mixed into the new session.
- [ ] Inaccessible/unreadable entry degrades without application termination.

Evidence / notes:

`<notes>`

## 6. Flow view

Result: `PASS / FAIL`

- [ ] Implemented Flow layout modes switch correctly.
- [ ] Rapid bidirectional scrolling remains usable.
- [ ] Filtering works without a new filesystem scan.
- [ ] Sorting works without a new filesystem scan.
- [ ] Selection behaves according to shared-session semantics.
- [ ] Preview activation and return preserve usable browsing state.
- [ ] No duplicate/permanently missing media remains after scan completion.

Evidence / notes:

`<notes>`

## 7. Free Canvas

Result: `PASS / FAIL`

- [ ] Canvas reuses the existing media session.
- [ ] Repeated pan/zoom remains responsive.
- [ ] LOD changes do not leave persistent stale textures.
- [ ] Selection is shared with Flow.
- [ ] Flow -> Canvas -> Flow does not duplicate session state.
- [ ] Repeated Canvas mount/unmount preserves intended camera/world state.

Telemetry snapshots:

| Point | Rendered items | Texture leases | Live refs | Unloading | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Initial steady state | `<n>` | `<n>` | `<n>` | `<n>` | |
| Peak churn | `<n>` | `<n>` | `<n>` | `<n>` | |
| Post-churn steady state | `<n>` | `<n>` | `<n>` | `<n>` | |

## 8. Preview and opaque media protocol

Result: `PASS / FAIL`

- [ ] Image preview displays correctly.
- [ ] Supported video playback starts.
- [ ] Supported audio playback starts.
- [ ] Seeking works in a sufficiently long media file.
- [ ] Repeated seek/back/forward does not break playback.
- [ ] Previous/next navigation works.
- [ ] Closing Preview returns to browsing.
- [ ] Supported metadata appears without blocking directory scanning.

Evidence / notes:

`<notes>`

## 9. Session replacement and stale-work rejection

Result: `PASS / FAIL`

- [ ] Replace source while thumbnail/detail work is active.
- [ ] Old media items do not reappear.
- [ ] Old thumbnail/detail results are ignored/released.
- [ ] Preview cannot be overwritten by stale metadata.
- [ ] New session remains interactive while old work converges.

Telemetry snapshots:

| Point | Active requests | Source registrations | Derived registrations | Notes |
| --- | ---: | ---: | ---: | --- |
| Before replacement | `<n>` | `<n>` | `<n>` | |
| During replacement | `<n>` | `<n>` | `<n>` | |
| Post-convergence | `<n>` | `<n>` | `<n>` | |

## 10. Long-session convergence

Result: `PASS / FAIL`

Workload performed:

- [ ] Sustained rapid Flow scrolling.
- [ ] Repeated Flow/Canvas switching.
- [ ] Repeated distant Canvas pan/zoom.
- [ ] Many Preview open/close cycles.
- [ ] Repeated filter/sort changes.
- [ ] At least one source replacement.

Runtime evidence:

| Point | Thumbnail requests | Derived registrations | Canvas leases | Canvas refs | Process memory (optional) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial steady state | `<n>` | `<n>` | `<n>` | `<n>` | `<value>` |
| Peak churn | `<n>` | `<n>` | `<n>` | `<n>` | `<value>` |
| Post-churn steady state | `<n>` | `<n>` | `<n>` | `<n>` | `<value>` |

Convergence assessment:

`<notes>`

## 11. Installer lifecycle

Result: `PASS / FAIL`

Automated evidence is recorded in section 1. Interactive/release-environment checks:

- [ ] Installer starts on the intended clean-user baseline.
- [ ] Installed app opens a usable native window.
- [ ] Reinstall/upgrade over the same version does not corrupt the app.
- [ ] User-driven uninstall completes.
- [ ] Expected package-owned binaries/entry are removed.
- [ ] User media remains untouched.
- [ ] Signing status is described accurately.

Evidence / notes:

`<notes>`

## 12. Defects and deviations

| Issue | Severity | Blocking? | Link / notes |
| --- | --- | --- | --- |
| `<issue>` | `<severity>` | `YES / NO` | `<link>` |

Skipped checks and justification:

`<none, or explicit justification>`

## 13. Final decision

- Automated gates: `PASS / FAIL`
- Interactive native acceptance: `PASS / FAIL / INCOMPLETE`
- Performance/resource convergence: `PASS / FAIL / INCOMPLETE`
- Installer lifecycle: `PASS / FAIL / INCOMPLETE`

**Desktop 1.0 candidate decision:** `ACCEPT / REJECT / INCOMPLETE`

Decision notes:

`<notes>`
