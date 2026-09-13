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

#[derive(Clone, Default)]
pub struct ThumbnailCacheManager {
    inner: Arc<Mutex<ThumbnailCacheState>>,
}

#[derive(Default)]
struct ThumbnailCacheState {
    active: HashMap<String, ActiveCachePath>,
    maintenance_initialized: bool,
    generated_since_maintenance: u64,
}

struct ActiveCachePath {
    path: PathBuf,
    registrations: u64,
}

impl ThumbnailCacheManager {
    /// Register one backend representation registration as an active cache
    /// consumer. Maintenance runs on the first registration and periodically
    /// after newly generated files. It never removes paths still registered as
    /// active and relies on a short age grace period to protect concurrently
    /// published files that have not reached registration yet.
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

        let report = prune_disk_cache(
            cache_root,
            thumbnail_cache_policy(),
            &protected_paths.expect("maintenance paths exist when maintenance is requested"),
        )
        .map_err(|error| error.to_string())?;
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

        {
            let state = manager.inner.lock().unwrap();
            assert_eq!(state.active.get("1/4").unwrap().registrations, 2);
        }

        manager.release("1/4").unwrap();
        {
            let state = manager.inner.lock().unwrap();
            assert_eq!(state.active.get("1/4").unwrap().registrations, 1);
        }

        manager.release("1/4").unwrap();
        assert!(!manager.inner.lock().unwrap().active.contains_key("1/4"));
    }

    #[test]
    fn release_of_unknown_key_is_idempotent() {
        let manager = ThumbnailCacheManager::default();
        manager.release("missing").unwrap();
        manager.release("missing").unwrap();
    }
}
