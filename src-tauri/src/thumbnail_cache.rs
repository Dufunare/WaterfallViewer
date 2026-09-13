use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use waterfall_infra::{prune_disk_cache, DiskCachePolicy, DiskCachePruneReport};

const THUMBNAIL_CACHE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const THUMBNAIL_CACHE_TARGET_BYTES: u64 = 1_700 * 1024 * 1024;
const THUMBNAIL_CACHE_MIN_AGE: Duration = Duration::from_secs(5 * 60);
const GENERATED_FILES_BETWEEN_MAINTENANCE: u64 = 64;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ThumbnailCacheTelemetrySnapshot {
    pub generated_registrations: u64,
    pub reused_registrations: u64,
    pub active_resource_keys: u64,
    pub active_registrations: u64,
    pub maintenance_runs: u64,
    pub maintenance_failures: u64,
    pub removed_files: u64,
    pub removed_bytes: u64,
    pub last_observed_cache_bytes: u64,
}

#[derive(Clone, Default)]
pub struct ThumbnailCacheManager {
    inner: Arc<Mutex<ThumbnailCacheState>>,
}

#[derive(Default)]
struct ThumbnailCacheState {
    active: HashMap<String, ActiveCachePath>,
    maintenance_initialized: bool,
    generated_since_maintenance: u64,
    telemetry: ThumbnailCacheTelemetry,
}

#[derive(Default)]
struct ThumbnailCacheTelemetry {
    generated_registrations: u64,
    reused_registrations: u64,
    maintenance_runs: u64,
    maintenance_failures: u64,
    removed_files: u64,
    removed_bytes: u64,
    last_observed_cache_bytes: u64,
}

struct ActiveCachePath {
    path: PathBuf,
    registrations: u64,
}

impl ThumbnailCacheManager {
    pub fn register_and_maintain(
        &self,
        resource_key: &str,
        path: &Path,
        cache_root: &Path,
        newly_generated: bool,
    ) -> Result<Option<DiskCachePruneReport>, String> {
        let (should_maintain, protected_paths) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "thumbnail cache manager lock poisoned".to_owned())?;

            match state.active.get_mut(resource_key) {
                Some(active) if active.path == path => {
                    active.registrations = active
                        .registrations
                        .checked_add(1)
                        .ok_or_else(|| "thumbnail cache registration count exhausted".to_owned())?;
                }
                Some(_) => {
                    return Err(
                        "thumbnail resource key was reused for a different cache path".to_owned(),
                    )
                }
                None => {
                    state.active.insert(
                        resource_key.to_owned(),
                        ActiveCachePath {
                            path: path.to_path_buf(),
                            registrations: 1,
                        },
                    );
                }
            }

            if newly_generated {
                state.generated_since_maintenance =
                    state.generated_since_maintenance.saturating_add(1);
                state.telemetry.generated_registrations =
                    state.telemetry.generated_registrations.saturating_add(1);
            } else {
                state.telemetry.reused_registrations =
                    state.telemetry.reused_registrations.saturating_add(1);
            }

            let should_maintain = !state.maintenance_initialized
                || state.generated_since_maintenance >= GENERATED_FILES_BETWEEN_MAINTENANCE;
            if should_maintain {
                state.maintenance_initialized = true;
                state.generated_since_maintenance = 0;
            }

            let protected_paths = should_maintain.then(|| {
                state
                    .active
                    .values()
                    .map(|active| active.path.clone())
                    .collect::<HashSet<_>>()
            });
            (should_maintain, protected_paths)
        };

        if !should_maintain {
            return Ok(None);
        }

        let report = match prune_disk_cache(
            cache_root,
            thumbnail_cache_policy(),
            &protected_paths.expect("maintenance paths exist when maintenance is requested"),
        ) {
            Ok(report) => report,
            Err(error) => {
                if let Ok(mut state) = self.inner.lock() {
                    state.telemetry.maintenance_failures =
                        state.telemetry.maintenance_failures.saturating_add(1);
                }
                return Err(error.to_string());
            }
        };

        let mut state = self
            .inner
            .lock()
            .map_err(|_| "thumbnail cache manager lock poisoned".to_owned())?;
        state.telemetry.maintenance_runs = state.telemetry.maintenance_runs.saturating_add(1);
        state.telemetry.removed_files = state
            .telemetry
            .removed_files
            .saturating_add(report.removed_files);
        state.telemetry.removed_bytes = state
            .telemetry
            .removed_bytes
            .saturating_add(report.removed_bytes);
        state.telemetry.last_observed_cache_bytes = report.after_bytes;

        Ok(Some(report))
    }

    pub fn release(&self, resource_key: &str) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "thumbnail cache manager lock poisoned".to_owned())?;
        let remove = match state.active.get_mut(resource_key) {
            Some(active) if active.registrations > 1 => {
                active.registrations -= 1;
                false
            }
            Some(_) => true,
            None => false,
        };
        if remove {
            state.active.remove(resource_key);
        }
        Ok(())
    }

    pub fn telemetry_snapshot(&self) -> Result<ThumbnailCacheTelemetrySnapshot, String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "thumbnail cache manager lock poisoned".to_owned())?;
        let active_registrations = state
            .active
            .values()
            .map(|active| active.registrations)
            .fold(0_u64, u64::saturating_add);

        Ok(ThumbnailCacheTelemetrySnapshot {
            generated_registrations: state.telemetry.generated_registrations,
            reused_registrations: state.telemetry.reused_registrations,
            active_resource_keys: state.active.len() as u64,
            active_registrations,
            maintenance_runs: state.telemetry.maintenance_runs,
            maintenance_failures: state.telemetry.maintenance_failures,
            removed_files: state.telemetry.removed_files,
            removed_bytes: state.telemetry.removed_bytes,
            last_observed_cache_bytes: state.telemetry.last_observed_cache_bytes,
        })
    }
}

fn thumbnail_cache_policy() -> DiskCachePolicy {
    DiskCachePolicy::new(
        THUMBNAIL_CACHE_MAX_BYTES,
        THUMBNAIL_CACHE_TARGET_BYTES,
        THUMBNAIL_CACHE_MIN_AGE,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn shared_resource_keys_remain_protected_until_final_release() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("thumb.png");
        fs::write(&path, b"thumbnail").unwrap();
        let manager = ThumbnailCacheManager::default();

        manager
            .register_and_maintain("1/4", &path, dir.path(), false)
            .unwrap();
        manager
            .register_and_maintain("1/4", &path, dir.path(), false)
            .unwrap();

        assert_eq!(
            manager.telemetry_snapshot().unwrap(),
            ThumbnailCacheTelemetrySnapshot {
                reused_registrations: 2,
                active_resource_keys: 1,
                active_registrations: 2,
                maintenance_runs: 1,
                last_observed_cache_bytes: b"thumbnail".len() as u64,
                ..ThumbnailCacheTelemetrySnapshot::default()
            }
        );

        manager.release("1/4").unwrap();
        let snapshot = manager.telemetry_snapshot().unwrap();
        assert_eq!(snapshot.active_resource_keys, 1);
        assert_eq!(snapshot.active_registrations, 1);

        manager.release("1/4").unwrap();
        let snapshot = manager.telemetry_snapshot().unwrap();
        assert_eq!(snapshot.active_resource_keys, 0);
        assert_eq!(snapshot.active_registrations, 0);
    }

    #[test]
    fn generated_and_reused_registrations_are_counted_separately() {
        let dir = tempdir().unwrap();
        let generated = dir.path().join("generated.png");
        let reused = dir.path().join("reused.png");
        fs::write(&generated, b"generated").unwrap();
        fs::write(&reused, b"reused").unwrap();
        let manager = ThumbnailCacheManager::default();

        manager
            .register_and_maintain("1/1", &generated, dir.path(), true)
            .unwrap();
        manager
            .register_and_maintain("1/2", &reused, dir.path(), false)
            .unwrap();

        let snapshot = manager.telemetry_snapshot().unwrap();
        assert_eq!(snapshot.generated_registrations, 1);
        assert_eq!(snapshot.reused_registrations, 1);
        assert_eq!(snapshot.active_resource_keys, 2);
        assert_eq!(snapshot.active_registrations, 2);
    }

    #[test]
    fn release_of_unknown_key_is_idempotent() {
        let manager = ThumbnailCacheManager::default();
        manager.release("missing").unwrap();
        manager.release("missing").unwrap();
        assert_eq!(
            manager.telemetry_snapshot().unwrap(),
            ThumbnailCacheTelemetrySnapshot::default()
        );
    }
}
