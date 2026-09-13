use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process,
    time::{Duration, Instant},
};

use tempfile::TempDir;
use walkdir::WalkDir;
use waterfall_core::MediaKind;
use waterfall_infra::{
    classification::classify_path, ImageThumbnailer, ThumbnailError, ThumbnailSpec,
};

const DEFAULT_RUNS: usize = 5;
const DEFAULT_WARMUPS: usize = 1;
const DEFAULT_MAX_EDGE: u32 = 256;

#[derive(Debug)]
struct Config {
    root: PathBuf,
    runs: usize,
    warmups: usize,
    max_edge: u32,
}

#[derive(Clone, Debug)]
struct Candidate {
    index: usize,
    path: PathBuf,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct PhaseCounts {
    attempted: u64,
    succeeded: u64,
    unsupported: u64,
    errors: u64,
    cache_bytes: u64,
}

impl PhaseCounts {
    fn merge(&mut self, other: Self) {
        self.attempted += other.attempted;
        self.succeeded += other.succeeded;
        self.unsupported += other.unsupported;
        self.errors += other.errors;
        self.cache_bytes += other.cache_bytes;
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct PhaseSample {
    elapsed: Duration,
    counts: PhaseCounts,
}

#[derive(Clone, Copy, Debug, Default)]
struct FormatSample {
    miss: PhaseSample,
    hit: PhaseSample,
}

type Corpus = BTreeMap<String, Vec<Candidate>>;
type RunSamples = BTreeMap<String, FormatSample>;

fn main() {
    let config = match parse_args(env::args().skip(1)) {
        Ok(config) => config,
        Err(message) => {
            eprintln!("{message}\n\n{}", usage());
            process::exit(2);
        }
    };

    if !config.root.is_dir() {
        eprintln!(
            "benchmark root is not a readable directory: {}",
            config.root.display()
        );
        process::exit(2);
    }

    let spec = ThumbnailSpec::new(config.max_edge).expect("validated thumbnail size");
    let corpus = collect_corpus(&config.root);
    let candidate_count: usize = corpus.values().map(Vec::len).sum();
    if candidate_count == 0 {
        eprintln!(
            "no image or animated-image files recognized by WaterfallViewer were found under {}",
            config.root.display()
        );
        process::exit(2);
    }

    let temp = TempDir::new().unwrap_or_else(|error| {
        eprintln!("failed to create temporary thumbnail cache: {error}");
        process::exit(1);
    });

    println!("WaterfallViewer thumbnail pipeline benchmark");
    println!("root: {}", config.root.display());
    println!("groups: {}", corpus.len());
    println!("candidates: {candidate_count}");
    println!("max_edge: {}", config.max_edge);
    println!("warmups: {}", config.warmups);
    println!("runs: {}", config.runs);
    println!(
        "note: corpus discovery and cache cleanup happen outside timing. Misses exercise production decode/resize/PNG encode/atomic write; hits reuse the existing PNG and read its dimensions."
    );

    for index in 0..config.warmups {
        let cache_root = temp.path().join(format!("warmup-{index}"));
        prepare_cache_dir(&cache_root);
        let _ = run_once(&corpus, &cache_root, spec);
        println!("warmup {:>2}: complete", index + 1);
    }

    let mut runs = Vec::with_capacity(config.runs);
    for index in 0..config.runs {
        let cache_root = temp.path().join(format!("run-{index}"));
        prepare_cache_dir(&cache_root);
        let samples = run_once(&corpus, &cache_root, spec);
        let (miss, hit) = summarize_run(&samples);
        println!(
            "run {:>2}: miss={:>9.3} ms generated={} unsupported={} errors={} cache={:.2} MiB | hit={:>9.3} ms reused={} errors={} | miss {:.1}/s hit {:.1}/s",
            index + 1,
            miss.elapsed.as_secs_f64() * 1_000.0,
            miss.counts.succeeded,
            miss.counts.unsupported,
            miss.counts.errors,
            mebibytes(miss.counts.cache_bytes),
            hit.elapsed.as_secs_f64() * 1_000.0,
            hit.counts.succeeded,
            hit.counts.errors,
            throughput(miss.counts.attempted, miss.elapsed),
            throughput(hit.counts.attempted, hit.elapsed),
        );
        runs.push(samples);
    }

    if !counts_stable(&runs) {
        eprintln!(
            "warning: thumbnail result counts changed between measured runs; the source or readable file state may have changed"
        );
    }

    println!("\nper-format medians:");
    for (extension, candidates) in &corpus {
        let miss_samples: Vec<PhaseSample> = runs
            .iter()
            .filter_map(|run| run.get(extension).map(|sample| sample.miss))
            .collect();
        let hit_samples: Vec<PhaseSample> = runs
            .iter()
            .filter_map(|run| run.get(extension).map(|sample| sample.hit))
            .collect();
        let miss = median_phase(&miss_samples);
        let hit = median_phase(&hit_samples);
        println!(
            "  {:>6}: files={:<6} miss={:>9.3} ms generated={} unsupported={} errors={} | hit={:>9.3} ms reused={} errors={}",
            extension,
            candidates.len(),
            miss.elapsed.as_secs_f64() * 1_000.0,
            miss.counts.succeeded,
            miss.counts.unsupported,
            miss.counts.errors,
            hit.elapsed.as_secs_f64() * 1_000.0,
            hit.counts.succeeded,
            hit.counts.errors,
        );
    }

    let total_misses: Vec<PhaseSample> = runs
        .iter()
        .map(|run| summarize_run(run).0)
        .collect();
    let total_hits: Vec<PhaseSample> = runs
        .iter()
        .map(|run| summarize_run(run).1)
        .collect();
    let miss = median_phase(&total_misses);
    let hit = median_phase(&total_hits);

    println!("\noverall medians:");
    println!(
        "  miss: {:>9.3} ms | attempted={} generated={} unsupported={} errors={} cache={:.2} MiB | {:.1} files/s",
        miss.elapsed.as_secs_f64() * 1_000.0,
        miss.counts.attempted,
        miss.counts.succeeded,
        miss.counts.unsupported,
        miss.counts.errors,
        mebibytes(miss.counts.cache_bytes),
        throughput(miss.counts.attempted, miss.elapsed),
    );
    println!(
        "  hit:  {:>9.3} ms | attempted={} reused={} errors={} | {:.1} files/s",
        hit.elapsed.as_secs_f64() * 1_000.0,
        hit.counts.attempted,
        hit.counts.succeeded,
        hit.counts.errors,
        throughput(hit.counts.attempted, hit.elapsed),
    );
}

fn collect_corpus(root: &Path) -> Corpus {
    let mut corpus = Corpus::new();
    let mut index = 0_usize;

    for entry in WalkDir::new(root).follow_links(false).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(kind) = classify_path(entry.path()) else {
            continue;
        };
        if !matches!(kind, MediaKind::Image | MediaKind::AnimatedImage) {
            continue;
        }

        let extension = entry
            .path()
            .extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_else(|| "<none>".to_string());
        corpus.entry(extension).or_default().push(Candidate {
            index,
            path: entry.path().to_path_buf(),
        });
        index += 1;
    }

    corpus
}

fn run_once(corpus: &Corpus, cache_root: &Path, spec: ThumbnailSpec) -> RunSamples {
    let thumbnailer = ImageThumbnailer;
    let mut result = RunSamples::new();

    for (extension, candidates) in corpus {
        let miss_started = Instant::now();
        let mut miss_counts = PhaseCounts::default();
        for candidate in candidates {
            let destination = cache_destination(cache_root, candidate.index);
            miss_counts.attempted += 1;
            match thumbnailer.ensure_png(&candidate.path, &destination, spec) {
                Ok(_) => {
                    miss_counts.succeeded += 1;
                    miss_counts.cache_bytes += file_len(&destination);
                }
                Err(error) if is_unsupported(&error) => miss_counts.unsupported += 1,
                Err(_) => miss_counts.errors += 1,
            }
        }
        let miss = PhaseSample {
            elapsed: miss_started.elapsed(),
            counts: miss_counts,
        };

        let hit_started = Instant::now();
        let mut hit_counts = PhaseCounts::default();
        for candidate in candidates {
            let destination = cache_destination(cache_root, candidate.index);
            if !destination.exists() {
                continue;
            }
            hit_counts.attempted += 1;
            match thumbnailer.ensure_png(&candidate.path, &destination, spec) {
                Ok(_) => {
                    hit_counts.succeeded += 1;
                    hit_counts.cache_bytes += file_len(&destination);
                }
                Err(error) if is_unsupported(&error) => hit_counts.unsupported += 1,
                Err(_) => hit_counts.errors += 1,
            }
        }
        let hit = PhaseSample {
            elapsed: hit_started.elapsed(),
            counts: hit_counts,
        };

        result.insert(extension.clone(), FormatSample { miss, hit });
    }

    result
}

fn prepare_cache_dir(path: &Path) {
    if path.exists() {
        fs::remove_dir_all(path).unwrap_or_else(|error| {
            eprintln!("failed to clear benchmark cache {}: {error}", path.display());
            process::exit(1);
        });
    }
    fs::create_dir_all(path).unwrap_or_else(|error| {
        eprintln!("failed to create benchmark cache {}: {error}", path.display());
        process::exit(1);
    });
}

fn cache_destination(cache_root: &Path, index: usize) -> PathBuf {
    cache_root.join(format!("{index:08}.png"))
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0)
}

fn is_unsupported(error: &ThumbnailError) -> bool {
    matches!(error, ThumbnailError::Unsupported(_) | ThumbnailError::Decode(_))
}

fn summarize_run(samples: &RunSamples) -> (PhaseSample, PhaseSample) {
    let mut miss = PhaseSample::default();
    let mut hit = PhaseSample::default();

    for sample in samples.values() {
        miss.elapsed += sample.miss.elapsed;
        miss.counts.merge(sample.miss.counts);
        hit.elapsed += sample.hit.elapsed;
        hit.counts.merge(sample.hit.counts);
    }

    (miss, hit)
}

fn counts_stable(runs: &[RunSamples]) -> bool {
    let Some(first) = runs.first() else {
        return true;
    };

    runs.iter().all(|run| {
        run.len() == first.len()
            && run.iter().all(|(extension, sample)| {
                first.get(extension).is_some_and(|baseline| {
                    baseline.miss.counts == sample.miss.counts
                        && baseline.hit.counts == sample.hit.counts
                })
            })
    })
}

fn median_phase(samples: &[PhaseSample]) -> PhaseSample {
    if samples.is_empty() {
        return PhaseSample::default();
    }

    let mut sorted = samples.to_vec();
    sorted.sort_unstable_by_key(|sample| sample.elapsed);
    sorted[sorted.len() / 2]
}

fn throughput(items: u64, elapsed: Duration) -> f64 {
    let seconds = elapsed.as_secs_f64();
    if seconds == 0.0 {
        0.0
    } else {
        items as f64 / seconds
    }
}

fn mebibytes(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Config, String> {
    let mut args = args.into_iter();
    let root = args
        .next()
        .ok_or_else(|| "missing benchmark root directory".to_string())?;
    if root == "-h" || root == "--help" {
        println!("{}", usage());
        process::exit(0);
    }

    let mut config = Config {
        root: PathBuf::from(root),
        runs: DEFAULT_RUNS,
        warmups: DEFAULT_WARMUPS,
        max_edge: DEFAULT_MAX_EDGE,
    };

    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--runs" => {
                let parsed = value
                    .parse::<usize>()
                    .map_err(|_| format!("invalid numeric value for {flag}: {value}"))?;
                if parsed == 0 {
                    return Err("--runs must be greater than zero".to_string());
                }
                config.runs = parsed;
            }
            "--warmups" => {
                config.warmups = value
                    .parse::<usize>()
                    .map_err(|_| format!("invalid numeric value for {flag}: {value}"))?;
            }
            "--max-edge" => {
                let parsed = value
                    .parse::<u32>()
                    .map_err(|_| format!("invalid numeric value for {flag}: {value}"))?;
                ThumbnailSpec::new(parsed).map_err(|error| error.to_string())?;
                config.max_edge = parsed;
            }
            _ => return Err(format!("unknown option: {flag}")),
        }
    }

    Ok(config)
}

fn usage() -> &'static str {
    "Usage: cargo run --release -p waterfall-infra --example thumbnail_bench -- <media-root> [--runs N] [--warmups N] [--max-edge N]"
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{counts_stable, median_phase, parse_args, FormatSample, PhaseCounts, PhaseSample, RunSamples};

    #[test]
    fn parses_defaults_and_overrides() {
        let defaults = parse_args(["media".to_string()]).expect("defaults should parse");
        assert_eq!(defaults.runs, 5);
        assert_eq!(defaults.warmups, 1);
        assert_eq!(defaults.max_edge, 256);

        let custom = parse_args([
            "media".to_string(),
            "--runs".to_string(),
            "7".to_string(),
            "--warmups".to_string(),
            "2".to_string(),
            "--max-edge".to_string(),
            "512".to_string(),
        ])
        .expect("custom values should parse");
        assert_eq!(custom.runs, 7);
        assert_eq!(custom.warmups, 2);
        assert_eq!(custom.max_edge, 512);
    }

    #[test]
    fn rejects_invalid_run_count_and_thumbnail_size() {
        let runs = parse_args(["media".to_string(), "--runs".to_string(), "0".to_string()])
            .expect_err("zero runs should fail");
        assert!(runs.contains("greater than zero"));

        let size = parse_args([
            "media".to_string(),
            "--max-edge".to_string(),
            "5000".to_string(),
        ])
        .expect_err("oversized thumbnail should fail");
        assert!(size.contains("max_edge"));
    }

    #[test]
    fn median_phase_uses_middle_timing_sample() {
        let samples = [
            PhaseSample {
                elapsed: Duration::from_millis(9),
                counts: PhaseCounts {
                    attempted: 9,
                    ..PhaseCounts::default()
                },
            },
            PhaseSample {
                elapsed: Duration::from_millis(1),
                counts: PhaseCounts {
                    attempted: 1,
                    ..PhaseCounts::default()
                },
            },
            PhaseSample {
                elapsed: Duration::from_millis(4),
                counts: PhaseCounts {
                    attempted: 4,
                    ..PhaseCounts::default()
                },
            },
        ];
        let median = median_phase(&samples);
        assert_eq!(median.elapsed, Duration::from_millis(4));
        assert_eq!(median.counts.attempted, 4);
    }

    #[test]
    fn detects_unstable_miss_or_hit_counts() {
        let mut first = RunSamples::new();
        first.insert(
            "jpg".to_string(),
            FormatSample {
                miss: PhaseSample {
                    elapsed: Duration::from_millis(10),
                    counts: PhaseCounts {
                        attempted: 1,
                        succeeded: 1,
                        cache_bytes: 100,
                        ..PhaseCounts::default()
                    },
                },
                hit: PhaseSample {
                    elapsed: Duration::from_millis(1),
                    counts: PhaseCounts {
                        attempted: 1,
                        succeeded: 1,
                        cache_bytes: 100,
                        ..PhaseCounts::default()
                    },
                },
            },
        );

        let mut second = first.clone();
        second.get_mut("jpg").expect("group exists").hit.counts.errors = 1;
        assert!(!counts_stable(&[first, second]));
    }
}
