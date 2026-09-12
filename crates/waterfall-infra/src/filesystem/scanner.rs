use std::{mem, path::Path, time::UNIX_EPOCH};

use waterfall_core::{
    CancellationProbe, MediaId, MediaItem, MediaScanner, ScanEvent, ScanEventSink, ScanFailure,
    ScanRequest, ScanSummary, ScanWarning,
};
use walkdir::WalkDir;

use crate::classification::classify_path;

#[derive(Debug, Default)]
pub struct LocalFilesystemScanner;

impl LocalFilesystemScanner {
    pub fn new() -> Self {
        Self
    }
}

impl MediaScanner for LocalFilesystemScanner {
    fn scan(
        &self,
        request: &ScanRequest,
        sink: &mut dyn ScanEventSink,
        cancellation: &dyn CancellationProbe,
    ) -> Result<(), ScanFailure> {
        request.validate()?;

        let root = Path::new(&request.source.locator);
        if !root.is_dir() {
            return Err(ScanFailure::source_unavailable(format!(
                "media source is not a readable directory: {}",
                request.source.locator
            )));
        }

        let session_id = request.session_id.clone();
        sink.emit(ScanEvent::Started {
            session_id: session_id.clone(),
        })?;

        let mut summary = ScanSummary::default();
        let mut batch = Vec::with_capacity(request.batch_size);

        for entry in WalkDir::new(root).follow_links(false) {
            if cancellation.is_cancelled() {
                flush_batch(sink, &session_id, &mut batch, &mut summary)?;
                sink.emit(ScanEvent::Cancelled {
                    session_id,
                    summary,
                })?;
                return Ok(());
            }

            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    let warning = ScanWarning {
                        path: error.path().map(path_to_portable_string),
                        message: error.to_string(),
                    };
                    sink.emit(ScanEvent::Warning {
                        session_id: session_id.clone(),
                        warning,
                    })?;
                    continue;
                }
            };

            if !entry.file_type().is_file() {
                continue;
            }

            summary.discovered_files += 1;

            let Some(kind) = classify_path(entry.path()) else {
                continue;
            };

            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    sink.emit(ScanEvent::Warning {
                        session_id: session_id.clone(),
                        warning: ScanWarning {
                            path: Some(path_to_portable_string(entry.path())),
                            message: error.to_string(),
                        },
                    })?;
                    continue;
                }
            };

            let relative_path = entry
                .path()
                .strip_prefix(root)
                .map(path_to_portable_string)
                .unwrap_or_else(|_| path_to_portable_string(entry.path()));

            let modified_at_ms = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64);

            let item = MediaItem {
                id: MediaId::new(format!(
                    "{}:{}",
                    request.source.id.as_str(),
                    relative_path
                )),
                source_id: request.source.id.clone(),
                name: entry.file_name().to_string_lossy().into_owned(),
                relative_path,
                kind,
                file_size: metadata.len(),
                modified_at_ms,
                visual: None,
            };

            summary.accepted_media += 1;
            batch.push(item);

            if batch.len() >= request.batch_size {
                flush_batch(sink, &session_id, &mut batch, &mut summary)?;
            }
        }

        flush_batch(sink, &session_id, &mut batch, &mut summary)?;
        sink.emit(ScanEvent::Finished {
            session_id,
            summary,
        })?;

        Ok(())
    }
}

fn flush_batch(
    sink: &mut dyn ScanEventSink,
    session_id: &waterfall_core::ScanSessionId,
    batch: &mut Vec<MediaItem>,
    summary: &mut ScanSummary,
) -> Result<(), ScanFailure> {
    if batch.is_empty() {
        return Ok(());
    }

    let items = mem::take(batch);
    batch.reserve(items.len());
    summary.emitted_batches += 1;
    sink.emit(ScanEvent::Batch {
        session_id: session_id.clone(),
        items,
    })
}

fn path_to_portable_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
