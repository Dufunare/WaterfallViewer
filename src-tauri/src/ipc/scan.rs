use std::{
    collections::{hash_map::Entry, HashMap},
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

use crate::{local_source::LocalSourceRegistry, media_resource::MediaResourceRegistry};

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

        match sessions.entry(session_id.to_owned()) {
            Entry::Occupied(_) => Err(ScanCommandError::session_exists(session_id)),
            Entry::Vacant(entry) => {
                let flag = Arc::new(AtomicBool::new(false));
                entry.insert(flag.clone());
                Ok(CancellationToken(flag))
            }
        }
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

#[derive(Clone, Debug)]
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
    source_locator: String,
    batch_size: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
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
    resource_key: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct VisualMetadataDto {
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Serialize)]
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

    fn source_unavailable(message: impl Into<String>) -> Self {
        Self::new("source-unavailable", message)
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

struct ChannelScanSink {
    channel: Channel<ScanEventDto>,
    resources: MediaResourceRegistry,
}

impl ChannelScanSink {
    fn new(channel: Channel<ScanEventDto>, resources: MediaResourceRegistry) -> Self {
        Self { channel, resources }
    }

    fn send(&self, event: ScanEventDto) -> Result<(), ScanFailure> {
        self.channel
            .send(event)
            .map_err(|error| ScanFailure::sink_closed(error.to_string()))
    }
}

impl ScanEventSink for ChannelScanSink {
    fn emit(&mut self, event: ScanEvent) -> Result<(), ScanFailure> {
        match event {
            ScanEvent::Batch { session_id, items } => {
                let session_id_string = session_id.as_str().to_owned();
                let mut dto_items = Vec::with_capacity(items.len());
                for item in items {
                    let resource_key = self
                        .resources
                        .register(&session_id_string, &item.relative_path)
                        .map_err(|error| {
                            ScanFailure::internal(format!(
                                "failed to register media resource: {error}"
                            ))
                        })?;
                    dto_items.push(MediaItemDto::from_item(item, resource_key));
                }
                self.send(ScanEventDto::Batch {
                    session_id: session_id_string,
                    items: dto_items,
                })
            }
            other => self.send(other.into()),
        }
    }
}

#[tauri::command]
pub async fn start_scan(
    registry: State<'_, ScanRegistry>,
    sources: State<'_, LocalSourceRegistry>,
    resources: State<'_, MediaResourceRegistry>,
    request: StartScanRequestDto,
    on_event: Channel<ScanEventDto>,
) -> Result<(), ScanCommandError> {
    if request.source_id.trim().is_empty() {
        return Err(ScanCommandError::invalid_request(
            "sourceId must not be empty",
        ));
    }

    let root_path = sources
        .resolve(&request.source_locator)
        .map_err(|error| ScanCommandError::source_unavailable(error.to_string()))?;
    let root_locator = root_path.into_os_string().into_string().map_err(|_| {
        ScanCommandError::source_unavailable("selected directory path is not valid UTF-8")
    })?;

    let registry = registry.inner().clone();
    let resources = resources.inner().clone();
    let session_id = request.session_id.clone();
    let cancellation = registry.register(&session_id)?;
    let scan_request = ScanRequest::new(
        request.session_id,
        MediaSource::new(SourceId::new(request.source_id), root_locator),
        request.batch_size,
    );

    if let Err(error) = scan_request.validate() {
        registry.remove(&session_id);
        return Err(error.into());
    }

    if let Err(error) = resources.begin_session(&session_id, &scan_request.source.locator) {
        registry.remove(&session_id);
        return Err(ScanCommandError::internal(format!(
            "failed to initialize media resource session: {error}"
        )));
    }

    let scan_resources = resources.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        let scanner = LocalFilesystemScanner::new();
        let mut sink = ChannelScanSink::new(on_event, scan_resources);
        scanner.scan(&scan_request, &mut sink, &cancellation)
    });

    let result = task.await;
    registry.remove(&session_id);

    let scan_result =
        result.map_err(|error| ScanCommandError::internal(format!("scan task failed: {error}")))?;
    scan_result.map_err(Into::into)
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
            ScanEvent::Batch { .. } => {
                unreachable!("batch events require media resource registration")
            }
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

impl MediaItemDto {
    fn from_item(item: MediaItem, resource_key: String) -> Self {
        Self {
            id: item.id.as_str().to_owned(),
            source_id: item.source_id.as_str().to_owned(),
            name: item.name,
            relative_path: item.relative_path,
            kind: media_kind_name(item.kind).to_owned(),
            file_size: item.file_size,
            modified_at_ms: item.modified_at_ms,
            visual: item.visual.map(Into::into),
            resource_key,
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
                resource_key: "3/8".to_owned(),
            }],
        };

        let json = serde_json::to_value(event).expect("serialize event");
        assert_eq!(json["event"], "batch");
        assert_eq!(json["data"]["sessionId"], "session-1");
        assert_eq!(json["data"]["items"][0]["sourceId"], "source-1");
        assert_eq!(json["data"]["items"][0]["relativePath"], "nested/photo.jpg");
        assert_eq!(json["data"]["items"][0]["fileSize"], 42);
        assert_eq!(json["data"]["items"][0]["visual"]["width"], 1920);
        assert_eq!(json["data"]["items"][0]["resourceKey"], "3/8");
    }
}
