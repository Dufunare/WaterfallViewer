use serde::Serialize;
use tauri::State;

use crate::{
    media_resource::{MediaResourceRegistry, MediaResourceTelemetrySnapshot},
    thumbnail_request::{ThumbnailRequestRegistry, ThumbnailRequestTelemetrySnapshot},
};

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResourceTelemetryDto {
    active_session: bool,
    generation: u64,
    source_resource_keys: u64,
    derived_resource_keys: u64,
    derived_registrations: u64,
    total_resource_keys: u64,
}

impl From<MediaResourceTelemetrySnapshot> for MediaResourceTelemetryDto {
    fn from(snapshot: MediaResourceTelemetrySnapshot) -> Self {
        Self {
            active_session: snapshot.active_session,
            generation: snapshot.generation,
            source_resource_keys: snapshot.source_resource_keys,
            derived_resource_keys: snapshot.derived_resource_keys,
            derived_registrations: snapshot.derived_registrations,
            total_resource_keys: snapshot.total_resource_keys,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailRequestTelemetryDto {
    active_requests: u64,
    cancelled_active_requests: u64,
    pending_cancellations: u64,
}

impl From<ThumbnailRequestTelemetrySnapshot> for ThumbnailRequestTelemetryDto {
    fn from(snapshot: ThumbnailRequestTelemetrySnapshot) -> Self {
        Self {
            active_requests: snapshot.active_requests,
            cancelled_active_requests: snapshot.cancelled_active_requests,
            pending_cancellations: snapshot.pending_cancellations,
        }
    }
}

#[tauri::command]
pub fn get_media_resource_telemetry(
    resources: State<'_, MediaResourceRegistry>,
) -> Result<MediaResourceTelemetryDto, String> {
    resources
        .telemetry_snapshot()
        .map(MediaResourceTelemetryDto::from)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_thumbnail_request_telemetry(
    requests: State<'_, ThumbnailRequestRegistry>,
) -> Result<ThumbnailRequestTelemetryDto, String> {
    requests
        .telemetry_snapshot()
        .map(ThumbnailRequestTelemetryDto::from)
}
