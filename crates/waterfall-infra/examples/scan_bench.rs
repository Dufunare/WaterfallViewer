use std::{
    env,
    path::PathBuf,
    process,
    time::{Duration, Instant},
};

use waterfall_core::{
    CancellationProbe, MediaScanner, MediaSource, ScanEvent, ScanEventSink, ScanFailure,
    ScanRequest, ScanSummary, SourceId,
};
use waterfall_infra::LocalFilesystemScanner;

const DEFAULT_RUNS: usize = 5;
const DEFAULT_WARMUPS: usize = 1;
const DEFAULT_BATCH_SIZE: usize = 64;

#[derive(Debug)]
struct Config {
    root: PathBuf,
    runs: usize,
    warmups: usize,
    batch_size: usize,
}

#[derive(Default)]
struct CollectingSink {
    warnings: u64,
    summary: Option<ScanSummary>,
}

impl ScanEventSink for CollectingSink {
    fn emit(&mut self, event: ScanEvent) -> Result<(), ScanFailure> {
        match event {
            ScanEvent::Warning { .. } => self.warnings += 1,
            ScanEvent::Finished { summary, .. } | ScanEvent::Cancelled { summary, .. } => {
                self.summary = Some(summary);
            }
            ScanEvent::Started { .. } | ScanEvent::Batch { .. } => {}
        }
        Ok(())
    }
}

struct NeverCancelled;

impl CancellationProbe for NeverCancelled {
    fn is_cancelled(&self) -> bool {
        false
    }
}

#[derive(Debug)]
struct Sample {
    elapsed: Duration,
    summary: ScanSummary,
    warnings: u64,
}

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

    let scanner = LocalFilesystemScanner::new();
    let request = ScanRequest::new(
        "filesystem-benchmark",
        MediaSource::new(SourceId::new("bench-source"), config.root.to_string_lossy()),
        config.batch_size,
    );

    println!("WaterfallViewer real-filesystem scan benchmark");
    println!("root: {}", config.root.display());
    println!("warmups: {}", config.warmups);
    println!("runs: {}", config.runs);
    println!("batch_size: {}", config.batch_size);
    println!("note: this exercises recursive discovery plus scan-time header visual metadata; OS/filesystem cache state is intentionally not controlled.");

    for index in 0..config.warmups {
        if let Err(error) = run_once(&scanner, &request) {
            eprintln!("warmup {} failed: {error}", index + 1);
            process::exit(1);
        }
    }

    let mut samples = Vec::with_capacity(config.runs);
    for index in 0..config.runs {
        match run_once(&scanner, &request) {
            Ok(sample) => {
                println!(
                    "run {:>2}: {:>9.3} ms | discovered={} accepted={} batches={} warnings={} | {:.1} accepted/s",
                    index + 1,
                    sample.elapsed.as_secs_f64() * 1_000.0,
                    sample.summary.discovered_files,
                    sample.summary.accepted_media,
                    sample.summary.emitted_batches,
                    sample.warnings,
                    throughput(sample.summary.accepted_media, sample.elapsed),
                );
                samples.push(sample);
            }
            Err(error) => {
                eprintln!("run {} failed: {error}", index + 1);
                process::exit(1);
            }
        }
    }

    if !summaries_match(&samples) {
        eprintln!("warning: scan counts changed between measured runs; the source may have changed during the benchmark");
    }

    let mut elapsed: Vec<Duration> = samples.iter().map(|sample| sample.elapsed).collect();
    elapsed.sort_unstable();
    let median = median_duration(&elapsed);
    let min = elapsed.first().copied().unwrap_or_default();
    let max = elapsed.last().copied().unwrap_or_default();
    let accepted = samples
        .last()
        .map(|sample| sample.summary.accepted_media)
        .unwrap_or_default();

    println!("\nsummary:");
    println!("  min:    {:>9.3} ms", min.as_secs_f64() * 1_000.0);
    println!("  median: {:>9.3} ms", median.as_secs_f64() * 1_000.0);
    println!("  max:    {:>9.3} ms", max.as_secs_f64() * 1_000.0);
    println!(
        "  median throughput: {:.1} accepted/s",
        throughput(accepted, median)
    );
}

fn run_once(
    scanner: &LocalFilesystemScanner,
    request: &ScanRequest,
) -> Result<Sample, ScanFailure> {
    let mut sink = CollectingSink::default();
    let started = Instant::now();
    scanner.scan(request, &mut sink, &NeverCancelled)?;
    let elapsed = started.elapsed();
    let summary = sink
        .summary
        .ok_or_else(|| ScanFailure::internal("scanner returned without a terminal summary"))?;

    Ok(Sample {
        elapsed,
        summary,
        warnings: sink.warnings,
    })
}

fn throughput(items: u64, elapsed: Duration) -> f64 {
    let seconds = elapsed.as_secs_f64();
    if seconds == 0.0 {
        0.0
    } else {
        items as f64 / seconds
    }
}

fn summaries_match(samples: &[Sample]) -> bool {
    let Some(first) = samples.first() else {
        return true;
    };
    samples.iter().all(|sample| sample.summary == first.summary)
}

fn median_duration(sorted: &[Duration]) -> Duration {
    match sorted.len() {
        0 => Duration::ZERO,
        len if len % 2 == 1 => sorted[len / 2],
        len => {
            let left = sorted[len / 2 - 1].as_nanos();
            let right = sorted[len / 2].as_nanos();
            let average = left + (right - left) / 2;
            Duration::from_nanos(average.min(u128::from(u64::MAX)) as u64)
        }
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
        batch_size: DEFAULT_BATCH_SIZE,
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
            "--batch-size" if parsed > 0 => config.batch_size = parsed,
            "--runs" | "--batch-size" => {
                return Err(format!("{flag} must be greater than zero"));
            }
            _ => return Err(format!("unknown option: {flag}")),
        }
    }

    Ok(config)
}

fn usage() -> &'static str {
    "Usage: cargo run -p waterfall-infra --example scan_bench -- <media-root> [--runs N] [--warmups N] [--batch-size N]"
}

#[cfg(test)]
mod tests {
    use super::{median_duration, parse_args};
    use std::time::Duration;

    #[test]
    fn parses_defaults_and_overrides() {
        let defaults = parse_args(["media".to_string()]).expect("defaults should parse");
        assert_eq!(defaults.runs, 5);
        assert_eq!(defaults.warmups, 1);
        assert_eq!(defaults.batch_size, 64);

        let custom = parse_args([
            "media".to_string(),
            "--runs".to_string(),
            "7".to_string(),
            "--warmups".to_string(),
            "2".to_string(),
            "--batch-size".to_string(),
            "128".to_string(),
        ])
        .expect("custom values should parse");
        assert_eq!(custom.runs, 7);
        assert_eq!(custom.warmups, 2);
        assert_eq!(custom.batch_size, 128);
    }

    #[test]
    fn rejects_zero_measured_runs() {
        let error = parse_args(["media".to_string(), "--runs".to_string(), "0".to_string()])
            .expect_err("zero runs should fail");
        assert!(error.contains("greater than zero"));
    }

    #[test]
    fn computes_even_and_odd_medians() {
        assert_eq!(
            median_duration(&[
                Duration::from_millis(1),
                Duration::from_millis(3),
                Duration::from_millis(9),
            ]),
            Duration::from_millis(3)
        );
        assert_eq!(
            median_duration(&[Duration::from_millis(2), Duration::from_millis(6),]),
            Duration::from_millis(4)
        );
    }
}
