use std::{
    path::{Path, PathBuf},
    sync::{
        mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
};

use rusqlite::{params, Connection};
use waterfall_core::{MediaKind, VisualMetadata};

use super::{
    InMemoryVisualMetadataCache, VisualMetadataCache, VisualMetadataCacheError,
    VisualMetadataCacheKey, VisualMetadataCacheLookup, DEFAULT_VISUAL_METADATA_CACHE_ENTRIES,
};

const SQLITE_CACHE_SCHEMA_VERSION: i64 = 1;
const DEFAULT_WRITE_QUEUE_CAPACITY: usize = 4_096;
const DEFAULT_WRITE_BATCH_SIZE: usize = 256;

const UPSERT_SQL: &str = r#"
INSERT INTO visual_metadata_cache (
    locator,
    file_size,
    modified_at_unix_ns,
    kind,
    parser_version,
    has_visual,
    width,
    height
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT(locator) DO UPDATE SET
    file_size = excluded.file_size,
    modified_at_unix_ns = excluded.modified_at_unix_ns,
    kind = excluded.kind,
    parser_version = excluded.parser_version,
    has_visual = excluded.has_visual,
    width = excluded.width,
    height = excluded.height
"#;

#[derive(Clone, Debug)]
struct PersistedVisualMetadataEntry {
    locator: String,
    file_size: u64,
    modified_at_unix_ns: u128,
    kind: MediaKind,
    parser_version: u32,
    value: Option<VisualMetadata>,
}

impl PersistedVisualMetadataEntry {
    fn from_cache_entry(key: &VisualMetadataCacheKey<'_>, value: Option<&VisualMetadata>) -> Self {
        Self {
            locator: key.locator.to_owned(),
            file_size: key.file_size,
            modified_at_unix_ns: key.modified_at_unix_ns,
            kind: key.kind.clone(),
            parser_version: key.parser_version,
            value: value.cloned(),
        }
    }
}

enum WriterCommand {
    Store(PersistedVisualMetadataEntry),
    Shutdown,
}

pub struct SqliteVisualMetadataCache {
    memory: Arc<InMemoryVisualMetadataCache>,
    writer: SyncSender<WriterCommand>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl SqliteVisualMetadataCache {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, VisualMetadataCacheError> {
        Self::with_max_entries(path, DEFAULT_VISUAL_METADATA_CACHE_ENTRIES)
    }

    pub fn with_max_entries(
        path: impl AsRef<Path>,
        max_entries: usize,
    ) -> Result<Self, VisualMetadataCacheError> {
        if max_entries == 0 {
            return Err(VisualMetadataCacheError::new(
                "SQLite visual metadata cache max_entries must be positive",
            ));
        }

        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                cache_error(
                    "failed to create SQLite visual metadata cache directory",
                    error,
                )
            })?;
        }

        let mut connection = open_connection(&path)?;
        initialize_schema(&mut connection)?;
        prune_database(&mut connection, max_entries)?;

        let memory = Arc::new(InMemoryVisualMetadataCache::with_max_entries(max_entries));
        load_into_memory(&connection, memory.as_ref())?;
        drop(connection);

        let (writer, receiver) = mpsc::sync_channel(DEFAULT_WRITE_QUEUE_CAPACITY);
        let worker_path = path.clone();
        let worker = thread::Builder::new()
            .name("visual-metadata-cache-writer".to_owned())
            .spawn(move || {
                writer_loop(worker_path, max_entries, DEFAULT_WRITE_BATCH_SIZE, receiver);
            })
            .map_err(|error| cache_error("failed to start SQLite cache writer", error))?;

        Ok(Self {
            memory,
            writer,
            worker: Mutex::new(Some(worker)),
        })
    }
}

impl VisualMetadataCache for SqliteVisualMetadataCache {
    fn lookup(
        &self,
        key: &VisualMetadataCacheKey<'_>,
    ) -> Result<VisualMetadataCacheLookup, VisualMetadataCacheError> {
        self.memory.lookup(key)
    }

    fn store(
        &self,
        key: &VisualMetadataCacheKey<'_>,
        value: Option<&VisualMetadata>,
    ) -> Result<(), VisualMetadataCacheError> {
        self.memory.store(key, value)?;

        let entry = PersistedVisualMetadataEntry::from_cache_entry(key, value);
        match self.writer.try_send(WriterCommand::Store(entry)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(VisualMetadataCacheError::new(
                "SQLite visual metadata cache write queue is full",
            )),
            Err(TrySendError::Disconnected(_)) => Err(VisualMetadataCacheError::new(
                "SQLite visual metadata cache writer is unavailable",
            )),
        }
    }
}

impl Drop for SqliteVisualMetadataCache {
    fn drop(&mut self) {
        let _ = self.writer.send(WriterCommand::Shutdown);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(handle) = worker.take() {
                let _ = handle.join();
            }
        }
    }
}

fn writer_loop(
    path: PathBuf,
    max_entries: usize,
    batch_size: usize,
    receiver: Receiver<WriterCommand>,
) {
    let Ok(mut connection) = open_connection(&path) else {
        return;
    };
    if initialize_schema(&mut connection).is_err() {
        return;
    }

    loop {
        let first = match receiver.recv() {
            Ok(command) => command,
            Err(_) => return,
        };

        let mut entries = Vec::with_capacity(batch_size);
        let mut shutdown_after_flush = false;
        match first {
            WriterCommand::Store(entry) => entries.push(entry),
            WriterCommand::Shutdown => return,
        }

        while entries.len() < batch_size {
            match receiver.try_recv() {
                Ok(WriterCommand::Store(entry)) => entries.push(entry),
                Ok(WriterCommand::Shutdown) => {
                    shutdown_after_flush = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    shutdown_after_flush = true;
                    break;
                }
            }
        }

        let _ = persist_batch(&mut connection, &entries, max_entries);
        if shutdown_after_flush {
            return;
        }
    }
}

fn open_connection(path: &Path) -> Result<Connection, VisualMetadataCacheError> {
    let connection = Connection::open(path)
        .map_err(|error| cache_error("failed to open SQLite visual metadata cache", error))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|error| cache_error("failed to configure SQLite busy timeout", error))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;\nPRAGMA synchronous = NORMAL;\nPRAGMA temp_store = MEMORY;",
        )
        .map_err(|error| cache_error("failed to configure SQLite visual metadata cache", error))?;
    Ok(connection)
}

fn initialize_schema(connection: &mut Connection) -> Result<(), VisualMetadataCacheError> {
    let version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|error| cache_error("failed to read SQLite cache schema version", error))?;

    if version > SQLITE_CACHE_SCHEMA_VERSION {
        return Err(VisualMetadataCacheError::new(format!(
            "SQLite visual metadata cache schema version {version} is newer than supported version {SQLITE_CACHE_SCHEMA_VERSION}"
        )));
    }

    connection
        .execute_batch(
            r#"
CREATE TABLE IF NOT EXISTS visual_metadata_cache (
    locator TEXT PRIMARY KEY NOT NULL,
    file_size TEXT NOT NULL,
    modified_at_unix_ns TEXT NOT NULL,
    kind INTEGER NOT NULL,
    parser_version INTEGER NOT NULL,
    has_visual INTEGER NOT NULL,
    width INTEGER,
    height INTEGER
);
PRAGMA user_version = 1;
"#,
        )
        .map_err(|error| cache_error("failed to initialize SQLite cache schema", error))?;
    Ok(())
}

fn load_into_memory(
    connection: &Connection,
    memory: &InMemoryVisualMetadataCache,
) -> Result<(), VisualMetadataCacheError> {
    let mut statement = connection
        .prepare(
            r#"
SELECT
    locator,
    file_size,
    modified_at_unix_ns,
    kind,
    parser_version,
    has_visual,
    width,
    height
FROM visual_metadata_cache
ORDER BY rowid ASC
"#,
        )
        .map_err(|error| cache_error("failed to prepare SQLite cache load", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
            ))
        })
        .map_err(|error| cache_error("failed to query SQLite cache entries", error))?;

    for row in rows {
        let Ok((
            locator,
            file_size,
            modified_at_unix_ns,
            kind,
            parser_version,
            has_visual,
            width,
            height,
        )) = row
        else {
            continue;
        };

        let Ok(file_size) = file_size.parse::<u64>() else {
            continue;
        };
        let Ok(modified_at_unix_ns) = modified_at_unix_ns.parse::<u128>() else {
            continue;
        };
        let Some(kind) = media_kind_from_i64(kind) else {
            continue;
        };
        let Ok(parser_version) = u32::try_from(parser_version) else {
            continue;
        };
        let value = match has_visual {
            0 => None,
            1 => {
                let (Some(width), Some(height)) = (width, height) else {
                    continue;
                };
                let (Ok(width), Ok(height)) = (u32::try_from(width), u32::try_from(height)) else {
                    continue;
                };
                Some(VisualMetadata { width, height })
            }
            _ => continue,
        };

        memory.store(
            &VisualMetadataCacheKey {
                locator: &locator,
                file_size,
                modified_at_unix_ns,
                kind: &kind,
                parser_version,
            },
            value.as_ref(),
        )?;
    }

    Ok(())
}

fn persist_batch(
    connection: &mut Connection,
    entries: &[PersistedVisualMetadataEntry],
    max_entries: usize,
) -> Result<(), VisualMetadataCacheError> {
    let transaction = connection
        .transaction()
        .map_err(|error| cache_error("failed to start SQLite cache transaction", error))?;

    {
        let mut statement = transaction
            .prepare_cached(UPSERT_SQL)
            .map_err(|error| cache_error("failed to prepare SQLite cache upsert", error))?;

        for entry in entries {
            let (has_visual, width, height) = match &entry.value {
                Some(metadata) => (
                    1_i64,
                    Some(i64::from(metadata.width)),
                    Some(i64::from(metadata.height)),
                ),
                None => (0_i64, None, None),
            };
            statement
                .execute(params![
                    entry.locator,
                    entry.file_size.to_string(),
                    entry.modified_at_unix_ns.to_string(),
                    media_kind_to_i64(&entry.kind),
                    i64::from(entry.parser_version),
                    has_visual,
                    width,
                    height,
                ])
                .map_err(|error| cache_error("failed to persist SQLite cache entry", error))?;
        }
    }

    prune_transaction(&transaction, max_entries)?;
    transaction
        .commit()
        .map_err(|error| cache_error("failed to commit SQLite cache transaction", error))
}

fn prune_database(
    connection: &mut Connection,
    max_entries: usize,
) -> Result<(), VisualMetadataCacheError> {
    let transaction = connection
        .transaction()
        .map_err(|error| cache_error("failed to start SQLite cache prune transaction", error))?;
    prune_transaction(&transaction, max_entries)?;
    transaction
        .commit()
        .map_err(|error| cache_error("failed to commit SQLite cache prune transaction", error))
}

fn prune_transaction(
    transaction: &rusqlite::Transaction<'_>,
    max_entries: usize,
) -> Result<(), VisualMetadataCacheError> {
    let count = transaction
        .query_row("SELECT COUNT(*) FROM visual_metadata_cache", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| cache_error("failed to count SQLite cache entries", error))?;
    let max_entries = i64::try_from(max_entries)
        .map_err(|_| VisualMetadataCacheError::new("SQLite cache entry budget is too large"))?;
    let excess = count.saturating_sub(max_entries);
    if excess > 0 {
        transaction
            .execute(
                r#"
DELETE FROM visual_metadata_cache
WHERE rowid IN (
    SELECT rowid
    FROM visual_metadata_cache
    ORDER BY rowid ASC
    LIMIT ?1
)
"#,
                params![excess],
            )
            .map_err(|error| cache_error("failed to prune SQLite cache entries", error))?;
    }
    Ok(())
}

fn media_kind_to_i64(kind: &MediaKind) -> i64 {
    match kind {
        MediaKind::Image => 0,
        MediaKind::AnimatedImage => 1,
        MediaKind::Video => 2,
        MediaKind::Audio => 3,
    }
}

fn media_kind_from_i64(value: i64) -> Option<MediaKind> {
    match value {
        0 => Some(MediaKind::Image),
        1 => Some(MediaKind::AnimatedImage),
        2 => Some(MediaKind::Video),
        3 => Some(MediaKind::Audio),
        _ => None,
    }
}

fn cache_error(context: &str, error: impl std::fmt::Display) -> VisualMetadataCacheError {
    VisualMetadataCacheError::new(format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    fn key<'a>(
        locator: &'a str,
        kind: &'a MediaKind,
        file_size: u64,
        modified_at_unix_ns: u128,
    ) -> VisualMetadataCacheKey<'a> {
        VisualMetadataCacheKey {
            locator,
            file_size,
            modified_at_unix_ns,
            kind,
            parser_version: 1,
        }
    }

    #[test]
    fn persists_visual_metadata_across_reopen() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("metadata.sqlite3");
        let kind = MediaKind::Image;
        let metadata = VisualMetadata {
            width: 1920,
            height: 1080,
        };

        {
            let cache =
                SqliteVisualMetadataCache::with_max_entries(&path, 10).expect("open SQLite cache");
            cache
                .store(&key("photo.jpg", &kind, 42, 100), Some(&metadata))
                .expect("store metadata");
        }

        let reopened =
            SqliteVisualMetadataCache::with_max_entries(&path, 10).expect("reopen SQLite cache");
        assert_eq!(
            reopened
                .lookup(&key("photo.jpg", &kind, 42, 100))
                .expect("lookup persisted metadata"),
            VisualMetadataCacheLookup::Hit(Some(metadata))
        );
    }

    #[test]
    fn persists_cached_none_results() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("metadata.sqlite3");
        let kind = MediaKind::Video;

        {
            let cache =
                SqliteVisualMetadataCache::with_max_entries(&path, 10).expect("open SQLite cache");
            cache
                .store(&key("broken.mp4", &kind, 64, 101), None)
                .expect("store cached miss");
        }

        let reopened =
            SqliteVisualMetadataCache::with_max_entries(&path, 10).expect("reopen SQLite cache");
        assert_eq!(
            reopened
                .lookup(&key("broken.mp4", &kind, 64, 101))
                .expect("lookup cached miss"),
            VisualMetadataCacheLookup::Hit(None)
        );
    }

    #[test]
    fn fingerprint_changes_still_miss_after_reopen() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("metadata.sqlite3");
        let kind = MediaKind::Image;
        let metadata = VisualMetadata {
            width: 800,
            height: 600,
        };

        {
            let cache =
                SqliteVisualMetadataCache::with_max_entries(&path, 10).expect("open SQLite cache");
            cache
                .store(&key("photo.jpg", &kind, 42, 100), Some(&metadata))
                .expect("store metadata");
        }

        let reopened =
            SqliteVisualMetadataCache::with_max_entries(&path, 10).expect("reopen SQLite cache");
        assert_eq!(
            reopened
                .lookup(&key("photo.jpg", &kind, 43, 100))
                .expect("lookup changed fingerprint"),
            VisualMetadataCacheLookup::Miss
        );
    }

    #[test]
    fn persistent_cache_prunes_oldest_entries_to_budget() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("metadata.sqlite3");
        let kind = MediaKind::Image;
        let metadata = VisualMetadata {
            width: 1,
            height: 1,
        };

        {
            let cache =
                SqliteVisualMetadataCache::with_max_entries(&path, 2).expect("open SQLite cache");
            for locator in ["a", "b", "c"] {
                cache
                    .store(&key(locator, &kind, 1, 1), Some(&metadata))
                    .expect("store entry");
            }
        }

        let reopened =
            SqliteVisualMetadataCache::with_max_entries(&path, 2).expect("reopen SQLite cache");
        assert_eq!(
            reopened.lookup(&key("a", &kind, 1, 1)).expect("lookup a"),
            VisualMetadataCacheLookup::Miss
        );
        assert_eq!(
            reopened.lookup(&key("b", &kind, 1, 1)).expect("lookup b"),
            VisualMetadataCacheLookup::Hit(Some(metadata.clone()))
        );
        assert_eq!(
            reopened.lookup(&key("c", &kind, 1, 1)).expect("lookup c"),
            VisualMetadataCacheLookup::Hit(Some(metadata))
        );
    }
}
