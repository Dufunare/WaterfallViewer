# Real-Corpus Performance Baseline

> Scope: local comparative evidence for scanner, active-media detail parsing and thumbnail generation/cache reuse
> Merge-gating policy: timings are **not** absolute CI thresholds

WaterfallViewer already contains three release-mode benchmark examples that exercise production infrastructure against caller-supplied media:

- `scan_bench`: recursive discovery plus scan-time header visual metadata;
- `media_detail_bench`: production `read_media_detail` dispatch over supported audio/video candidates;
- `thumbnail_bench`: production image/animated-image thumbnail miss generation and immediate existing-file reuse.

`scripts/run-real-corpus-baseline.ps1` runs all three with one corpus and one run/warmup policy, then stores the raw outputs together with basic environment metadata under an ignored `acceptance-results/` directory.

## Usage

From the repository root in PowerShell:

```powershell
./scripts/run-real-corpus-baseline.ps1 -MediaRoot "D:\Media\AcceptanceCorpus"
```

Optional parameters:

```powershell
./scripts/run-real-corpus-baseline.ps1 `
  -MediaRoot "D:\Media\AcceptanceCorpus" `
  -Runs 7 `
  -Warmups 2 `
  -MaxEdge 256 `
  -OutputRoot "acceptance-results"
```

Each capture creates a timestamped directory containing:

```text
environment.txt
scan-bench.txt
media-detail-bench.txt
thumbnail-bench.txt
```

The environment file records the Git commit, corpus root, benchmark parameters, OS/architecture, logical processor count and Rust/Cargo versions. Record storage type, power mode, unusual thermal conditions and material corpus changes alongside the capture when they may affect comparison quality.

## Comparison protocol

For a meaningful before/after comparison:

1. use the same machine and storage path when practical;
2. use the same corpus contents;
3. keep `Runs`, `Warmups` and `MaxEdge` unchanged;
4. avoid comparing a battery-throttled run against a plugged-in/high-performance run;
5. prefer benchmark-reported medians over one-off timings;
6. compare per-format results as well as aggregate results when the corpus mix is heterogeneous;
7. treat unstable counts between measured runs as contaminated evidence and repeat after verifying the corpus is not changing.

OS/filesystem caches are intentionally not normalized. The benchmark suite is meant to detect engineering regressions and improvements under comparable local conditions, not to manufacture a universal throughput claim.

## Relationship to CI

Do **not** copy local millisecond thresholds into GitHub-hosted runner gates. Shared runner hardware, storage and cache state are noisy and not representative of a user's local media library.

CI continues to enforce deterministic architecture/performance contracts such as bounded visible/render sets and bounded representation work. Real-corpus measurements complement those contracts with comparative production-path evidence.

## Relationship to Desktop 1.0 acceptance

A Desktop 1.0 candidate should attach or reference a representative real-corpus capture in its acceptance record when performance/resource behavior is being signed off. The capture does not replace interactive long-session telemetry: scanner/detail/thumbnail latency and frontend/resource-lifetime convergence measure different failure modes.

When comparing release candidates, retain the raw output files rather than transcribing only a single aggregate number. This preserves format counts, unsupported/error counts and cache-miss/reuse detail needed to explain changes.
