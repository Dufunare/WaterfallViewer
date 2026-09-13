use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::local_source::{LocalSourceError, LocalSourceRegistry};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedSourceDto {
    source_id: String,
    locator: String,
    display_name: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SourceCommandError {
    code: String,
    message: String,
}

impl SourceCommandError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<LocalSourceError> for SourceCommandError {
    fn from(error: LocalSourceError) -> Self {
        let code = match error {
            LocalSourceError::InvalidDirectory => "invalid-source",
            LocalSourceError::Unavailable(_) => "source-unavailable",
            LocalSourceError::RegistryPoisoned => "internal",
        };
        Self::new(code, error.to_string())
    }
}

#[tauri::command]
pub async fn pick_source_directory(
    app: AppHandle,
    sources: State<'_, LocalSourceRegistry>,
) -> Result<Option<PickedSourceDto>, SourceCommandError> {
    #[cfg(feature = "native-e2e")]
    if let Some(path) = std::env::var_os("WATERFALL_NATIVE_E2E_SOURCE") {
        let source = sources.register(path)?;
        return Ok(Some(source.into()));
    }

    let selected = app.dialog().file().blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(None);
    };

    let path = selected
        .into_path()
        .map_err(|error| SourceCommandError::new("invalid-source", error.to_string()))?;
    let source = sources.register(path)?;

    Ok(Some(source.into()))
}

impl From<crate::local_source::RegisteredLocalSource> for PickedSourceDto {
    fn from(source: crate::local_source::RegisteredLocalSource) -> Self {
        Self {
            source_id: source.source_id,
            locator: source.locator,
            display_name: source.display_name,
        }
    }
}
