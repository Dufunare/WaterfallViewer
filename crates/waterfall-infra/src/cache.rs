use std::{
    collections::HashSet,
    fs,
    io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiskCachePolicy {
    pub max_bytes: u64,
    pub target_bytes: u64,
    pub min_age: Duration,
}

impl DiskCachePolicy {
    pub const fn new(max_bytes: u64, target_bytes: u64, min_age: Duration) -> Self {
        Self {
            max_bytes,
            target_bytes,
            min_age,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DiskCachePruneReport {
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub removed_files: u64,
    pub removed_bytes: u64,
}

#[derive(Debug)]
struct CacheEntry {
    path: PathBuf,
    bytes: u64,
    modified: SystemTime,
}

/// Prune a disposable cache directory toward `target_bytes` once it exceeds
/// `max_bytes`.
///
/// Paths listed in `protected_paths` are never removed. Files younger than the
/// policy's `min_age` are also protected. The age guard makes the routine safe
/// to use next to producers that may have atomically published a cache file but
/// have not yet registered the file with their consumer-lifetime tracker.
///
/// The cache directory is intentionally treated as disposable state. A missing
/// directory is a successful no-op.
pub fn prune_disk_cache(
    root: &Path,
    policy: DiskCachePolicy,
    protected_paths: &HashSet<PathBuf>,
) -> io::Result<DiskCachePruneReport> {
    validate_policy(policy)?;

    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(DiskCachePruneReport::default())
        }
        Err(error) => return Err(error),
    };

    let now = SystemTime::now();
    let mut total_bytes = 0_u64;
    let mut candidates = Vec::new();

    for entry in entries {
        let entry = entry?;
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if !metadata.is_file() {
            continue;
        }

        let path = entry.path();
        let bytes = metadata.len();
        total_bytes = total_bytes.saturating_add(bytes);

        if protected_paths.contains(&path) {
            continue;
        }

        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
        if age < policy.min_age {
            continue;
        }

        candidates.push(CacheEntry {
            path,
            bytes,
            modified,
        });
    }

    let before_bytes = total_bytes;
    if total_bytes <= policy.max_bytes {
        return Ok(DiskCachePruneReport {
            before_bytes,
            after_bytes: total_bytes,
            ..DiskCachePruneReport::default()
        });
    }

    candidates.sort_by(|left, right| {
        left.modified
            .cmp(&right.modified)
            .then_with(|| left.path.cmp(&right.path))
    });

    let mut removed_files = 0_u64;
    let mut removed_bytes = 0_u64;

    for candidate in candidates {
        if total_bytes <= policy.target_bytes {
            break;
        }

        match fs::remove_file(&candidate.path) {
            Ok(()) => {
                total_bytes = total_bytes.saturating_sub(candidate.bytes);
                removed_files += 1;
                removed_bytes = removed_bytes.saturating_add(candidate.bytes);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                total_bytes = total_bytes.saturating_sub(candidate.bytes);
            }
            Err(error) => return Err(error),
        }
    }

    Ok(DiskCachePruneReport {
        before_bytes,
        after_bytes: total_bytes,
        removed_files,
        removed_bytes,
    })
}

fn validate_policy(policy: DiskCachePolicy) -> io::Result<()> {
    if policy.max_bytes == 0 || policy.target_bytes > policy.max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "disk cache policy requires max_bytes > 0 and target_bytes <= max_bytes",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_file(path: &Path, bytes: usize) {
        fs::write(path, vec![0_u8; bytes]).unwrap();
    }

    #[test]
    fn leaves_cache_untouched_below_limit() {
        let dir = tempdir().unwrap();
        write_file(&dir.path().join("a.bin"), 20);
        write_file(&dir.path().join("b.bin"), 30);

        let report = prune_disk_cache(
            dir.path(),
            DiskCachePolicy::new(100, 80, Duration::ZERO),
            &HashSet::new(),
        )
        .unwrap();

        assert_eq!(report.before_bytes, 50);
        assert_eq!(report.after_bytes, 50);
        assert_eq!(report.removed_files, 0);
        assert!(dir.path().join("a.bin").exists());
        assert!(dir.path().join("b.bin").exists());
    }

    #[test]
    fn prunes_until_target_when_over_limit() {
        let dir = tempdir().unwrap();
        for name in ["a.bin", "b.bin", "c.bin"] {
            write_file(&dir.path().join(name), 40);
        }

        let report = prune_disk_cache(
            dir.path(),
            DiskCachePolicy::new(100, 60, Duration::ZERO),
            &HashSet::new(),
        )
        .unwrap();

        assert_eq!(report.before_bytes, 120);
        assert!(report.after_bytes <= 60);
        assert_eq!(report.removed_files, 2);
        assert_eq!(report.removed_bytes, 80);
    }

    #[test]
    fn never_removes_protected_paths() {
        let dir = tempdir().unwrap();
        let protected = dir.path().join("active.bin");
        let disposable = dir.path().join("old.bin");
        write_file(&protected, 80);
        write_file(&disposable, 80);

        let protected_paths = HashSet::from([protected.clone()]);
        let report = prune_disk_cache(
            dir.path(),
            DiskCachePolicy::new(100, 60, Duration::ZERO),
            &protected_paths,
        )
        .unwrap();

        assert!(protected.exists());
        assert!(!disposable.exists());
        assert_eq!(report.after_bytes, 80);
        assert_eq!(report.removed_files, 1);
    }

    #[test]
    fn grace_period_protects_newly_published_files() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first.bin");
        let second = dir.path().join("second.bin");
        write_file(&first, 80);
        write_file(&second, 80);

        let report = prune_disk_cache(
            dir.path(),
            DiskCachePolicy::new(100, 60, Duration::from_secs(60)),
            &HashSet::new(),
        )
        .unwrap();

        assert_eq!(report.before_bytes, 160);
        assert_eq!(report.after_bytes, 160);
        assert_eq!(report.removed_files, 0);
        assert!(first.exists());
        assert!(second.exists());
    }

    #[test]
    fn missing_cache_directory_is_a_noop() {
        let dir = tempdir().unwrap();
        let report = prune_disk_cache(
            &dir.path().join("missing"),
            DiskCachePolicy::new(100, 80, Duration::ZERO),
            &HashSet::new(),
        )
        .unwrap();

        assert_eq!(report, DiskCachePruneReport::default());
    }
}
