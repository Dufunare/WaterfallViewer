use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, RwLock},
};

use waterfall_core::{
    MediaFileFingerprint, MediaKind, MetadataReadFailure, VisualMetadata, VisualMetadataReader,
};

pub const VISUAL_METADATA_PARSER_VERSION: u32 = 1;
pub const DEFAULT_VISUAL_METADATA_CACHE_ENTRIES: usize = 100_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VisualMetadataCacheLookup {
    Miss,
    Hit(Option<VisualMetadata>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VisualMetadataCacheError {
    message: String,
}

impl VisualMetadataCacheError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for VisualMetadataCacheError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for VisualMetadataCacheError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VisualMetadataCacheKey<'a> {
    pub locator: &'a str,
    pub file_size: u64,
    pub modified_at_unix_ns: u128,
    pub kind: &'a MediaKind,
    pub parser_version: u32,
}

pub trait VisualMetadataCache: Send + Sync {
    fn lookup(
        &self,
        key: &VisualMetadataCacheKey<'_>,
    ) -> Result<VisualMetadataCacheLookup, VisualMetadataCacheError>;

    fn store(
        &self,
        key: &VisualMetadataCacheKey<'_>,
        value: Option<&VisualMetadata>,
    ) -> Result<(), VisualMetadataCacheError>;
}

impl<T> VisualMetadataCache for Arc<T>
where
    T: VisualMetadataCache + ?Sized,
{
    fn lookup(
        &self,
        key: &VisualMetadataCacheKey<'_>,
    ) -> Result<VisualMetadataCacheLookup, VisualMetadataCacheError> {
        self.as_ref().lookup(key)
    }

    fn store(
        &self,
        key: &VisualMetadataCacheKey<'_>,
        value: Option<&VisualMetadata>,
    ) -> Result<(), VisualMetadataCacheError> {
        self.as_ref().store(key, value)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CachedVisualMetadataEntry {
    file_size: u64,
    modified_at_unix_ns: u128,
    kind: MediaKind,
    parser_version: u32,
    value: Option<VisualMetadata>,
}

#[derive(Debug, Default)]
struct InMemoryCacheState {
    entries: HashMap<String, CachedVisualMetadataEntry>,
    insertion_order: VecDeque<String>,
}

#[derive(Debug)]
pub struct InMemoryVisualMetadataCache {
    state: RwLock<InMemoryCacheState>,
    max_entries: usize,
}

impl Default for InMemoryVisualMetadataCache {
    fn default() -> Self {
        Self::with_max_entries(DEFAULT_VISUAL_METADATA_CACHE_ENTRIES)
    }
}

impl InMemoryVisualMetadataCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_max_entries(max_entries: usize) -> Self {
        assert!(max_entries > 0, "max_entries must be positive");
        Self {
            state: RwLock::new(InMemoryCacheState::default()),
            max_entries,
        }
    }

    pub fn len(&self) -> Result<usize, VisualMetadataCacheError> {
        self.state
            .read()
            .map(|state| state.entries.len())
            .map_err(|_| VisualMetadataCacheError::new("visual metadata cache lock poisoned"))
    }

    pub fn is_empty(&self) -> Result<bool, VisualMetadataCacheError> {
        self.len().map(|length| length == 0)
    }

    pub fn max_entries(&self) -> usize {
        self.max_entries
    }
}

impl VisualMetadataCache for InMemoryVisualMetadataCache {
    fn lookup(
        &self,
        key: &VisualMetadataCacheKey<'_>,
    ) -> Result<VisualMetadataCacheLookup, VisualMetadataCacheError> {
        let state = self
            .state
            .read()
            .map_err(|_| VisualMetadataCacheError::new("visual metadata cache lock poisoned"))?;
        let Some(entry) = state.entries.get(key.locator) else {
            return Ok(VisualMetadataCacheLookup::Miss);
        };

        if entry.file_size != key.file_size
            || entry.modified_at_unix_ns != key.modified_at_unix_ns
            || &entry.kind != key.kind
            || entry.parser_version != key.parser_version
        {
            return Ok(VisualMetadataCacheLookup::Miss);
        }

        Ok(VisualMetadataCacheLookup::Hit(entry.value.clone()))
    }

    fn store(
        &self,
        key: &VisualMetadataCacheKey<'_>,
        value: Option<&VisualMetadata>,
    ) -> Result<(), VisualMetadataCacheError> {
        let mut state = self
            .state
            .write()
            .map_err(|_| VisualMetadataCacheError::new("visual metadata cache lock poisoned"))?;

        if !state.entries.contains_key(key.locator) {
            while state.entries.len() >= self.max_entries {
                let Some(oldest_locator) = state.insertion_order.pop_front() else {
                    break;
                };
                state.entries.remove(&oldest_locator);
            }
            state.insertion_order.push_back(key.locator.to_owned());
        }

        state.entries.insert(
            key.locator.to_owned(),
            CachedVisualMetadataEntry {
                file_size: key.file_size,
                modified_at_unix_ns: key.modified_at_unix_ns,
                kind: key.kind.clone(),
                parser_version: key.parser_version,
                value: value.cloned(),
            },
        );
        Ok(())
    }
}

#[derive(Debug)]
pub struct CachingVisualMetadataReader<R, C> {
    inner: R,
    cache: C,
    parser_version: u32,
}

impl<R, C> CachingVisualMetadataReader<R, C> {
    pub fn new(inner: R, cache: C) -> Self {
        Self::with_parser_version(inner, cache, VISUAL_METADATA_PARSER_VERSION)
    }

    pub fn with_parser_version(inner: R, cache: C, parser_version: u32) -> Self {
        Self {
            inner,
            cache,
            parser_version,
        }
    }
}

impl<R, C> VisualMetadataReader for CachingVisualMetadataReader<R, C>
where
    R: VisualMetadataReader,
    C: VisualMetadataCache,
{
    fn read_visual_metadata(
        &self,
        locator: &str,
        kind: &MediaKind,
    ) -> Result<Option<VisualMetadata>, MetadataReadFailure> {
        self.inner.read_visual_metadata(locator, kind)
    }

    fn read_visual_metadata_with_fingerprint(
        &self,
        locator: &str,
        kind: &MediaKind,
        fingerprint: Option<MediaFileFingerprint>,
    ) -> Result<Option<VisualMetadata>, MetadataReadFailure> {
        if matches!(kind, MediaKind::Audio) {
            return self
                .inner
                .read_visual_metadata_with_fingerprint(locator, kind, fingerprint);
        }

        let Some(fingerprint) = fingerprint else {
            return self.inner.read_visual_metadata(locator, kind);
        };
        let Some(modified_at_unix_ns) = fingerprint.modified_at_unix_ns else {
            return self.inner.read_visual_metadata_with_fingerprint(
                locator,
                kind,
                Some(fingerprint),
            );
        };
        let key = VisualMetadataCacheKey {
            locator,
            file_size: fingerprint.file_size,
            modified_at_unix_ns,
            kind,
            parser_version: self.parser_version,
        };

        if let Ok(VisualMetadataCacheLookup::Hit(value)) = self.cache.lookup(&key) {
            return Ok(value);
        }

        let value =
            self.inner
                .read_visual_metadata_with_fingerprint(locator, kind, Some(fingerprint))?;
        let _ = self.cache.store(&key, value.as_ref());
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[derive(Debug)]
    struct CountingReader {
        calls: AtomicUsize,
        value: Option<VisualMetadata>,
    }

    impl CountingReader {
        fn new(value: Option<VisualMetadata>) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                value,
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::Relaxed)
        }
    }

    impl VisualMetadataReader for CountingReader {
        fn read_visual_metadata(
            &self,
            _locator: &str,
            _kind: &MediaKind,
        ) -> Result<Option<VisualMetadata>, MetadataReadFailure> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(self.value.clone())
        }
    }

    #[derive(Debug)]
    struct FailingCache;

    impl VisualMetadataCache for FailingCache {
        fn lookup(
            &self,
            _key: &VisualMetadataCacheKey<'_>,
        ) -> Result<VisualMetadataCacheLookup, VisualMetadataCacheError> {
            Err(VisualMetadataCacheError::new("lookup failed"))
        }

        fn store(
            &self,
            _key: &VisualMetadataCacheKey<'_>,
            _value: Option<&VisualMetadata>,
        ) -> Result<(), VisualMetadataCacheError> {
            Err(VisualMetadataCacheError::new("store failed"))
        }
    }

    #[test]
    fn reuses_cached_metadata_while_file_fingerprint_is_stable() {
        let reader = CachingVisualMetadataReader::new(
            CountingReader::new(Some(VisualMetadata {
                width: 1920,
                height: 1080,
            })),
            InMemoryVisualMetadataCache::new(),
        );
        let fingerprint = fingerprint(6, Some(10));

        let first = reader
            .read_visual_metadata_with_fingerprint(
                "image.png",
                &MediaKind::Image,
                Some(fingerprint),
            )
            .expect("first read");
        let second = reader
            .read_visual_metadata_with_fingerprint(
                "image.png",
                &MediaKind::Image,
                Some(fingerprint),
            )
            .expect("cached read");

        assert_eq!(first, second);
        assert_eq!(reader.inner.calls(), 1);
        assert_eq!(reader.cache.len().expect("cache length"), 1);
    }

    #[test]
    fn invalidates_cache_when_file_fingerprint_changes() {
        let reader = CachingVisualMetadataReader::new(
            CountingReader::new(Some(VisualMetadata {
                width: 800,
                height: 600,
            })),
            InMemoryVisualMetadataCache::new(),
        );

        reader
            .read_visual_metadata_with_fingerprint(
                "image.png",
                &MediaKind::Image,
                Some(fingerprint(5, Some(10))),
            )
            .expect("first read");
        reader
            .read_visual_metadata_with_fingerprint(
                "image.png",
                &MediaKind::Image,
                Some(fingerprint(14, Some(11))),
            )
            .expect("invalidated read");

        assert_eq!(reader.inner.calls(), 2);
    }

    #[test]
    fn bypasses_cache_when_modified_time_is_unavailable() {
        let reader = CachingVisualMetadataReader::new(
            CountingReader::new(Some(VisualMetadata {
                width: 800,
                height: 600,
            })),
            InMemoryVisualMetadataCache::new(),
        );
        let fingerprint = fingerprint(5, None);

        for _ in 0..2 {
            reader
                .read_visual_metadata_with_fingerprint(
                    "image.png",
                    &MediaKind::Image,
                    Some(fingerprint),
                )
                .expect("uncached read");
        }

        assert_eq!(reader.inner.calls(), 2);
        assert!(reader.cache.is_empty().expect("cache state"));
    }

    #[test]
    fn caches_successful_none_results_for_unchanged_files() {
        let reader = CachingVisualMetadataReader::new(
            CountingReader::new(None),
            InMemoryVisualMetadataCache::new(),
        );
        let fingerprint = fingerprint(15, Some(10));

        assert_eq!(
            reader
                .read_visual_metadata_with_fingerprint(
                    "broken.jpg",
                    &MediaKind::Image,
                    Some(fingerprint),
                )
                .expect("first read"),
            None
        );
        assert_eq!(
            reader
                .read_visual_metadata_with_fingerprint(
                    "broken.jpg",
                    &MediaKind::Image,
                    Some(fingerprint),
                )
                .expect("cached read"),
            None
        );
        assert_eq!(reader.inner.calls(), 1);
    }

    #[test]
    fn parser_version_and_media_kind_are_part_of_the_cache_identity() {
        let cache = Arc::new(InMemoryVisualMetadataCache::new());
        let fingerprint = fingerprint(6, Some(10));

        let first = CachingVisualMetadataReader::with_parser_version(
            CountingReader::new(Some(VisualMetadata {
                width: 640,
                height: 480,
            })),
            cache.clone(),
            1,
        );
        first
            .read_visual_metadata_with_fingerprint(
                "media.bin",
                &MediaKind::Image,
                Some(fingerprint),
            )
            .expect("first read");
        first
            .read_visual_metadata_with_fingerprint(
                "media.bin",
                &MediaKind::Video,
                Some(fingerprint),
            )
            .expect("kind invalidation");
        assert_eq!(first.inner.calls(), 2);

        let second = CachingVisualMetadataReader::with_parser_version(
            CountingReader::new(Some(VisualMetadata {
                width: 640,
                height: 480,
            })),
            cache,
            2,
        );
        second
            .read_visual_metadata_with_fingerprint(
                "media.bin",
                &MediaKind::Video,
                Some(fingerprint),
            )
            .expect("version invalidation");
        assert_eq!(second.inner.calls(), 1);
    }

    #[test]
    fn evicts_oldest_locator_when_the_entry_budget_is_full() {
        let cache = InMemoryVisualMetadataCache::with_max_entries(2);
        let kind = MediaKind::Image;
        let metadata = VisualMetadata {
            width: 1,
            height: 1,
        };

        for locator in ["a", "b", "c"] {
            cache
                .store(
                    &VisualMetadataCacheKey {
                        locator,
                        file_size: 1,
                        modified_at_unix_ns: 1,
                        kind: &kind,
                        parser_version: 1,
                    },
                    Some(&metadata),
                )
                .expect("store cache entry");
        }

        assert_eq!(cache.len().expect("cache length"), 2);
        assert_eq!(
            cache
                .lookup(&VisualMetadataCacheKey {
                    locator: "a",
                    file_size: 1,
                    modified_at_unix_ns: 1,
                    kind: &kind,
                    parser_version: 1,
                })
                .expect("lookup evicted entry"),
            VisualMetadataCacheLookup::Miss
        );
        for locator in ["b", "c"] {
            assert!(matches!(
                cache
                    .lookup(&VisualMetadataCacheKey {
                        locator,
                        file_size: 1,
                        modified_at_unix_ns: 1,
                        kind: &kind,
                        parser_version: 1,
                    })
                    .expect("lookup retained entry"),
                VisualMetadataCacheLookup::Hit(Some(_))
            ));
        }
    }

    #[test]
    fn cache_adapter_failure_degrades_to_the_underlying_reader() {
        let reader = CachingVisualMetadataReader::new(
            CountingReader::new(Some(VisualMetadata {
                width: 320,
                height: 240,
            })),
            FailingCache,
        );
        let fingerprint = fingerprint(6, Some(10));

        for _ in 0..2 {
            assert_eq!(
                reader
                    .read_visual_metadata_with_fingerprint(
                        "image.png",
                        &MediaKind::Image,
                        Some(fingerprint),
                    )
                    .expect("reader survives cache failure"),
                Some(VisualMetadata {
                    width: 320,
                    height: 240,
                })
            );
        }
        assert_eq!(reader.inner.calls(), 2);
    }

    fn fingerprint(file_size: u64, modified_at_unix_ns: Option<u128>) -> MediaFileFingerprint {
        MediaFileFingerprint {
            file_size,
            modified_at_unix_ns,
        }
    }
}
