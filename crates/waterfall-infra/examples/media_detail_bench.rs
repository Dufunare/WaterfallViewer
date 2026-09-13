use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
    process,
    time::{Duration, Instant},
};

use walkdir::WalkDir;
use waterfall_core::MediaKind;
use waterfall_infra::{classification::classify_path, read_media_detail};

const DEFAULT_RUNS: usize = 5;
const DEFAULT_WARMUPS: usize = 1;

#[derive(Debug)]
struct Config {
    root: PathBuf,
    runs: usize,
    warmups: usize,
}

#[derive(Clone, Debug)]
struct Candidate {
    locator: String,
    kind: MediaKind,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct ParseCounts {
    attempted: u64,
    detailed: u64,
    unsupported: u64,
    errors: u64,
}

impl ParseCounts {
    fn merge(&mut self, other: Self) {
        self.attempted += other.attempted;
        self.detailed += other.detailed;
        self.unsupported += other.unsupported;
        self.errors += other.errors;
    }
}

#[derive(Clone, Copy, Debug)]
struct GroupSample {
    elapsed: Duration,
    counts: ParseCounts,
}

type Corpus = BTreeMap<String, Vec<Candidate>>;
type RunSamples = BTreeMap<String, GroupSample>;

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

    let corpus = collect_corpus(&config.root);
    let candidate_count: usize = corpus.values().map(Vec::len).sum();
    if candidate_count == 0 {
        eprintln!(
            "no audio/video files recognized by WaterfallViewer were found under {}",
            config.root.display()
        );
        process::exit(2);
    }

    println!("WaterfallViewer active-media detail parser benchmark");
    println!("root: {}", config.root.display());
    println!("groups: {}", corpus.len());
    println!("candidates: {candidate_count}");
    println!("warmups: {}", config.warmups);
    println!("runs: {}", config.runs);
    println!(
        "note: corpus discovery happens before timing; measured work is read_media_detail over audio/video candidates. OS/filesystem cache state is intentionally not controlled."
    );

    for index in 0..config.warmups {
        let _ = run_once(&corpus);
        println!("warmup {:>2}: complete", index + 1);
    }

    let mut runs = Vec::with_capacity(config.runs);
    for index in 0..config.runs {
        let samples = run_once(&corpus);
        let (elapsed, counts) = summarize_run(&samples);
        println!(
            "run {:>2}: {:>9.3} ms | attempted={} detailed={} unsupported={} errors={} | {:.1} files/s",
            index + 1,
            elapsed.as_secs_f64() * 1_000.0,
            counts.attempted,
            counts.detailed,
            counts.unsupported,
            counts.errors,
            throughput(counts.attempted, elapsed),
        );
        runs.push(samples);
    }

    if !counts_stable(&runs) {
        eprintln!(
            "warning: parser result counts changed between measured runs; the source or readable file state may have changed"
        );
    }

    println!("\nper-format medians:");
    for (extension, candidates) in &corpus {
        let samples: Vec<GroupSample> = runs
            .iter()
            .filter_map(|run| run.get(extension).copied())
            .collect();
        let median = median_sample(&samples);
        println!(
            "  {:>6}: files={:<6} median={:>9.3} ms | detailed={} unsupported={} errors={} | {:.1} files/s",
            extension,
            candidates.len(),
            median.elapsed.as_secs_f64() * 1_000.0,
            median.counts.detailed,
            median.counts.unsupported,
            median.counts.errors,
            throughput(median.counts.attempted, median.elapsed),
        );
    }

    let total_samples: Vec<GroupSample> = runs
        .iter()
        .map(|run| {
            let (elapsed, counts) = summarize_run(run);
            GroupSample { elapsed, counts }
        })
        .collect();
    let total = median_sample(&total_samples);
    println!("\noverall median:");
    println!("  elapsed: {:>9.3} ms", total.elapsed.as_secs_f64() * 1_000.0);
    println!(
        "  counts: attempted={} detailed={} unsupported={} errors={}",
        total.counts.attempted,
        total.counts.detailed,
        total.counts.unsupported,
        total.counts.errors
    );
    println!(
        "  throughput: {:.1} files/s",
        throughput(total.counts.attempted, total.elapsed)
    );
}

fn collect_corpus(root: &Path) -> Corpus {
    let mut corpus = Corpus::new();
    for entry in WalkDir::new(root).follow_links(false).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(kind) = classify_path(entry.path()) else {
            continue;
        };
        if !matches!(kind, MediaKind::Audio | MediaKind::Video) {
            continue;
        }
        let extension = entry
            .path()
            .extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_else(|| "<none>".to_string());
        corpus.entry(extension).or_default().push(Candidate {
            locator: entry.path().to_string_lossy().into_owned(),
            kind,
        });
    }
    corpus
}

fn run_once(corpus: &Corpus) -> RunSamples {
    let mut result = RunSamples::new();
    for (extension, candidates) in corpus {
        let started = Instant::now();
        let mut counts = ParseCounts::default();
        for candidate in candidates {
            counts.attempted += 1;
            match read_media_detail(&candidate.locator, &candidate.kind) {
                Ok(Some(_)) => counts.detailed += 1,
                Ok(None) => counts.unsupported += 1,
                Err(_) => counts.errors += 1,
            }
        }
        result.insert(
            extension.clone(),
            GroupSample {
                elapsed: started.elapsed(),
                counts,
            },
        );
    }
    result
}

fn summarize_run(samples: &RunSamples) -> (Duration, ParseCounts) {
    let mut elapsed = Duration::ZERO;
    let mut counts = ParseCounts::default();
    for sample in samples.values() {
        elapsed += sample.elapsed;
        counts.merge(sample.counts);
    }
    (elapsed, counts)
}

fn counts_stable(runs: &[RunSamples]) -> bool {
    let Some(first) = runs.first() else {
        return true;
    };
    runs.iter().all(|run| {
        run.len() == first.len()
            && run.iter().all(|(extension, sample)| {
                first
                    .get(extension)
                    .is_some_and(|baseline| baseline.counts == sample.counts)
            })
    })
}

fn median_sample(samples: &[GroupSample]) -> GroupSample {
    if samples.is_empty() {
        return GroupSample {
            elapsed: Duration::ZERO,
            counts: ParseCounts::default(),
        };
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
    };

    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        let parsed = value
            .parse::<usize>()
            .map_err(|_| format!("invalid numeric value for {flag}: {value}"))?;
        match flag.as_str() {
            "--runs" if parsed > 0 => config.runs = parsed,
            "--warmups" => config.warmups = parsed,
            "--runs" => return Err("--runs must be greater than zero".to_string()),
            _ => return Err(format!("unknown option: {flag}")),
        }
    }

    Ok(config)
}

fn usage() -> &'static str {
    "Usage: cargo run --release -p waterfall-infra --example media_detail_bench -- <media-root> [--runs N] [--warmups N]"
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{counts_stable, median_sample, parse_args, GroupSample, ParseCounts, RunSamples};

    #[test]
    fn parses_defaults_and_overrides() {
        let defaults = parse_args(["media".to_string()]).expect("defaults should parse");
        assert_eq!(defaults.runs, 5);
        assert_eq!(defaults.warmups, 1);

        let custom = parse_args([
            "media".to_string(),
            "--runs".to_string(),
            "7".to_string(),
            "--warmups".to_string(),
            "2".to_string(),
        ])
        .expect("custom values should parse");
        assert_eq!(custom.runs, 7);
        assert_eq!(custom.warmups, 2);
    }

    #[test]
    fn rejects_zero_measured_runs() {
        let error = parse_args(["media".to_string(), "--runs".to_string(), "0".to_string()])
            .expect_err("zero runs should fail");
        assert!(error.contains("greater than zero"));
    }

    #[test]
    fn median_sample_uses_middle_timing_sample() {
        let samples = [
            GroupSample {
                elapsed: Duration::from_millis(9),
                counts: ParseCounts {
                    attempted: 9,
                    ..ParseCounts::default()
                },
            },
            GroupSample {
                elapsed: Duration::from_millis(1),
                counts: ParseCounts {
                    attempted: 1,
                    ..ParseCounts::default()
                },
            },
            GroupSample {
                elapsed: Duration::from_millis(4),
                counts: ParseCounts {
                    attempted: 4,
                    ..ParseCounts::default()
                },
            },
        ];
        let median = median_sample(&samples);
        assert_eq!(median.elapsed, Duration::from_millis(4));
        assert_eq!(median.counts.attempted, 4);
    }

    #[test]
    fn detects_unstable_counts() {
        let mut first = RunSamples::new();
        first.insert(
            "mp3".to_string(),
            GroupSample {
                elapsed: Duration::from_millis(1),
                counts: ParseCounts {
                    attempted: 1,
                    detailed: 1,
                    ..ParseCounts::default()
                },
            },
        );
        let mut second = first.clone();
        second.get_mut("mp3").expect("group exists").counts.errors = 1;
        assert!(!counts_stable(&[first, second]));
    }
}
