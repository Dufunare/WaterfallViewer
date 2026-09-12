use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};
use waterfall_core::{
    CancellationProbe, MediaItem, MediaKind, MediaScanner, MediaSource, ScanEvent, ScanEventSink,
    ScanFailure, ScanFailureKind, ScanRequest, ScanSummary, ScanWarning, SourceId, VisualMetadata,
};
use waterfall_infra::LocalFilesystemScanner;

#[derive(Clone, Default)]
pub struct ScanRegistry {
    sessions: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl ScanRegistry {
    fn register(&self, session_id: &str) -> Result<CancellationToken, ScanCommandError> {
        if session_id.trim().is_empty() {
            return Err(ScanCommandError::invalid_request(
                "sessionId must not be empty",
            ));
        }

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| ScanCommandError::internal("scan registry lock poisoned"))?;

        if sessions.contains_key(session_id) {
            return Err(ScanCommandError::session_exists(session_id));
        }

        let flag = Arc::new(AtomicBool::new(false));
        sessions.insert(session_id.to_owned(), flag.clone());
        Ok(CancellationToken(flag))
    }

    fn cancel(&self, session_id: &str) -> Result<bool, ScanCommandError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| ScanCommandError::internal("scan registry lock poisoned"))?;
        let Some(flag) = sessions.get(session_id) else {
            return Ok(false);
        };
        flag.store(true, Ordering::Release);
        Ok(true)
    }

    fn remove(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
    }
}

#[derive(Clone)]
struct CancellationToken(Arc<AtomicBool>);

impl CancellationProbe for CancellationToken {
    fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartScanRequestDto {
    session_id: String,
    source_id: String,
    root_path: String,
    batch_size: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "event", content = "data")]
pub enum ScanEventDto {
    Started {
        session_id: String,
    },
    Batch {
        session_id: String,
        items: Vec<MediaItemDto>,
    },
    Warning {
        session_id: String,
        warning: ScanWarningDto,
    },
    Finished {
        session_id: String,
        summary: ScanSummaryDto,
    },
    Cancelled {
        session_id: String,
        summary: ScanSummaryDto,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItemDto {
    id: String,
    source_id: String,
    name: String,
    relative_path: String,
    kind: String,
    file_size: u64,
    modified_at_ms: Option<u64>,
    visual: Option<VisualMetadataDto>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualMetadataDto {
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanWarningDto {
    path: Option<String>,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummaryDto {
    discovered_files: u64,
    accepted_media: u64,
    emitted_batches: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCommandError {
    code: String,
    message: String,
}

impl ScanCommandError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn invalid_request(message: impl Into<String>) -> Self {
        Self::new("invalid-request", message)
    }

    fn session_exists(session_id: &str) -> Self {
        Self::new(
            "session-exists",
            format!("scan session already exists: {session_id}"),
        )
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message)
    }
}

impl From<ScanFailure> for ScanCommandError {
    fn from(error: ScanFailure) -> Self {
        let code = match error.kind {
            ScanFailureKind::InvalidRequest => "invalid-request",
            ScanFailureKind::SourceUnavailable => "source-unavailable",
            ScanFailureKind::SinkClosed => "sink-closed",
            ScanFailureKind::Internal => "internal",
        };
        Self::new(code, error.message)
    }
}

struct ChannelScanSink(Channel<ScanEventDto>);

impl ScanEventSink for ChannelScanSink {
    fn emit(&mut self, event: ScanEvent) -> Result<(), ScanFailure> {
        self.0
            .send(event.into())
            .map_err(|error| ScanFailure::sink_closed(error.to_string()))
    }
}

#[tauri::command]
pub async fn start_scan(
    registry: State<'_, ScanRegistry>,
    request: StartScanRequestDto,
    on_event: Channel<ScanEventDto>,
) -> Result<(), ScanCommandError> {
    if request.source_id.trim().is_empty() {
        return Err(ScanCommandError::invalid_request(
            "sourceId must not be empty",
        ));
    }

    let registry = registry.inner().clone();
    let session_id = request.session_id.clone();
    let cancellation = registry.register(&session_id)?;
    let scan_request = ScanRequest::new(
        request.session_id,
        MediaSource::new(SourceId::new(request.source_id), request.root_path),
        request.batch_size,
    );

    let task = tauri::async_runtime::spawn_blocking(move || {
        let scanner = LocalFilesystemScanner::new();
        let mut sink = ChannelScanSink(on_event);
        scanner.scan(&scan_request, &mut sink, &cancellation)
    });

    let result = task
        .await
        .map_err(|error| ScanCommandError::internal(format!("scan task failed: {error}")))?;
    registry.remove(&session_id);
    result.map_err(Into::into)
}

#[tauri::command]
pub fn cancel_scan(
    registry: State<'_, ScanRegistry>,
    session_id: String,
) -> Result<bool, ScanCommandError> {
    registry.cancel(&session_id)
}

impl From<ScanEvent> for ScanEventDto {
    fn from(event: ScanEvent) -> Self {
        match event {
            ScanEvent::Started { session_id } => Self::Started {
                session_id: session_id.as_str().to_owned(),
            },
            ScanEvent::Batch { session_id, items } => Self::Batch {
                session_id: session_id.as_str().to_owned(),
                items: items.into_iter().map(Into::into).collect(),
            },
            ScanEvent::Warning {
                session_id,
                warning,
            } => Self::Warning {
                session_id: session_id.as_str().to_owned(),
                warning: warning.into(),
            },
            ScanEvent::Finished {
                session_id,
                summary,
            } => Self::Finished {
                session_id: session_id.as_str().to_owned(),
                summary: summary.into(),
            },
            ScanEvent::Cancelled {
                session_id,
                summary,
            } => Self::Cancelled {
                session_id: session_id.as_str().to_owned(),
                summary: summary.into(),
            },
        }
    }
}

impl From<MediaItem> for MediaItemDto {
    fn from(item: MediaItem) -> Self {
        Self {
            id: item.id.as_str().to_owned(),
            source_id: item.source_id.as_str().to_owned(),
            name: item.name,
            relative_path: item.relative_path,
            kind: media_kind_name(item.kind).to_owned(),
            file_size: item.file_size,
            modified_at_ms: item.modified_at_ms,
            visual: item.visual.map(Into::into),
        }
    }
}

impl From<VisualMetadata> for VisualMetadataDto {
    fn from(metadata: VisualMetadata) -> Self {
        Self {
            width: metadata.width,
            height: metadata.height,
        }
    }
}

impl From<ScanWarning> for ScanWarningDto {
    fn from(warning: ScanWarning) -> Self {
        Self {
            path: warning.path,
            message: warning.message,
        }
    }
}

impl From<ScanSummary> for ScanSummaryDto {
    fn from(summary: ScanSummary) -> Self {
        Self {
            discovered_files: summary.discovered_files,
            accepted_media: summary.accepted_media,
            emitted_batches: summary.emitted_batches,
        }
    }
}

fn media_kind_name(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Image => "image",
        MediaKind::AnimatedImage => "animated-image",
        MediaKind::Video => "video",
        MediaKind::Audio => "audio",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_rejects_duplicate_sessions_and_supports_cancellation() {
        let registry = ScanRegistry::default();
        let token = registry.register("session-1").expect("register session");
        assert!(!token.is_cancelled());

        let duplicate = registry.register("session-1").expect_err("duplicate fails");
        assert_eq!(duplicate.code, "session-exists");

        assert!(registry.cancel("session-1").expect("cancel session"));
        assert!(token.is_cancelled());
        assert!(!registry.cancel("missing").expect("missing session"));

        registry.remove("session-1");
        registry
            .register("session-1")
            .expect("session id reusable after removal");
    }

    #[test]
    fn event_dto_uses_stable_camel_case_contract() {
        let event = ScanEventDto::Batch {
            session_id: "session-1".to_owned(),
            items: vec![MediaItemDto {
                id: "media-1".to_owned(),
                source_id: "source-1".to_owned(),
                name: "photo.jpg".to_owned(),
                relative_path: "nested/photo.jpg".to_owned(),
                kind: "image".to_owned(),
                file_size: 42,
                modified_at_ms: Some(7),
                visual: Some(VisualMetadataDto {
                    width: 1920,
                    height: 1080,
                }),
            }],
        };

        let json = serde_json::to_value(event).expect("serialize event");
        assert_eq!(json["event"], "batch");
        assert_eq!(json["data"]["sessionId"], "session-1");
        assert_eq!(json["data"]["items"][0]["sourceId"], "source-1");
        assert_eq!(json["data"]["items"][0]["relativePath"], "nested/photo.jpg");
        assert_eq!(json["data"]["items"][0]["fileSize"], 42);
        assert_eq!(json["data"]["items"][0]["visual"]["width"], 1920);
    }
}
