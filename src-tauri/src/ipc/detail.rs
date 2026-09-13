use serde::Serialize;
use tauri::State;
use waterfall_core::{MediaDetail, MediaKind};
use waterfall_infra::read_media_detail;

use crate::media_resource::MediaResourceRegistry;

#[derive(Clone, Debug, Serialize)]
pub struct MediaDetailCommandError {
    code: String,
    message: String,
}

impl MediaDetailCommandError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[tauri::command]
pub async fn get_media_detail(
    resources: State<'_, MediaResourceRegistry>,
    resource_key: String,
    kind: MediaKind,
) -> Result<Option<MediaDetail>, MediaDetailCommandError> {
    if resource_key.trim().is_empty() {
        return Err(MediaDetailCommandError::new(
            "invalid-request",
            "resourceKey must not be empty",
        ));
    }
    if matches!(kind, MediaKind::Image | MediaKind::AnimatedImage) {
        return Ok(None);
    }

    let path = resources.resolve(&resource_key).ok_or_else(|| {
        MediaDetailCommandError::new(
            "resource-unavailable",
            "resource key is not active or registered",
        )
    })?;

    tauri::async_runtime::spawn_blocking(move || {
        read_media_detail(&path.to_string_lossy(), &kind)
            .map_err(|error| MediaDetailCommandError::new("metadata-unavailable", error.to_string()))
    })
    .await
    .map_err(|error| {
        MediaDetailCommandError::new("internal", format!("media detail task failed: {error}"))
    })?
}
