use serde::Serialize;
use tauri::State;

use crate::thumbnail_request::{
    ThumbnailRequestRegistry, ThumbnailRequestTelemetrySnapshot,
};

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
pub fn get_thumbnail_request_telemetry(
    requests: State<'_, ThumbnailRequestRegistry>,
) -> Result<ThumbnailRequestTelemetryDto, String> {
    requests
        .telemetry_snapshot()
        .map(ThumbnailRequestTelemetryDto::from)
}
