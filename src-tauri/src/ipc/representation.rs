use std::{
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use waterfall_infra::{
    ImageThumbnailer, ThumbnailCancellationToken, ThumbnailError, ThumbnailSpec,
};

use crate::{
    media_resource::{MediaResourceRegistry, ResourceRegistryError},
    thumbnail_cache::ThumbnailCacheManager,
    thumbnail_request::ThumbnailRequestRegistry,
};

const THUMBNAIL_CACHE_VERSION: &[u8] = b"waterfall-thumbnail-v1";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailRepresentationDto {
    resource_key: String,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct RepresentationCommandError {
    code: String,
    message: String,
}

impl RepresentationCommandError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn invalid_request(message: impl Into<String>) -> Self {
        Self::new("invalid-request", message)
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new("resource-unavailable", message)
    }

    fn unsupported(message: impl Into<String>) -> Self {
        Self::new("unsupported-representation", message)
    }

    fn cancelled() -> Self {
        Self::new("cancelled", "thumbnail request was cancelled")
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message)
    }
}

#[tauri::command]
pub async fn request_thumbnail(
    app: AppHandle,
    resources: State<'_, MediaResourceRegistry>,
    cache: State<'_, ThumbnailCacheManager>,
    requests: State<'_, ThumbnailRequestRegistry>,
    request_id: String,
    resource_key: String,
    max_edge: u32,
) -> Result<ThumbnailRepresentationDto, RepresentationCommandError> {
    if request_id.trim().is_empty() {
        return Err(RepresentationCommandError::invalid_request(
            "requestId must not be empty",
        ));
    }
    if resource_key.trim().is_empty() {
        return Err(RepresentationCommandError::invalid_request(
            "resourceKey must not be empty",
        ));
    }
    let spec = ThumbnailSpec::new(max_edge).map_err(map_thumbnail_error)?;
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| RepresentationCommandError::internal(error.to_string()))?
        .join("representations")
        .join("image-thumbnails")
        .join("v1");
    let resources = resources.inner().clone();
    let cache = cache.inner().clone();
    let requests = requests.inner().clone();
    let cancellation = requests
        .register(&request_id)
        .map_err(RepresentationCommandError::internal)?;

    let task = tauri::async_runtime::spawn_blocking(move || {
        generate_thumbnail_representation(
            resources,
            cache,
            resource_key,
            cache_root,
            spec,
            cancellation,
        )
    })
    .await;

    if let Err(error) = requests.finish(&request_id) {
        eprintln!("failed to finish thumbnail request {request_id}: {error}");
    }

    task.map_err(|error| {
        RepresentationCommandError::internal(format!("thumbnail task failed: {error}"))
    })?
}

#[tauri::command]
pub fn cancel_thumbnail_request(
    requests: State<'_, ThumbnailRequestRegistry>,
    request_id: String,
) -> Result<bool, RepresentationCommandError> {
    if request_id.trim().is_empty() {
        return Err(RepresentationCommandError::invalid_request(
            "requestId must not be empty",
        ));
    }
    requests
        .cancel(&request_id)
        .map_err(RepresentationCommandError::internal)
}

#[tauri::command]
pub fn release_representation(
    resources: State<'_, MediaResourceRegistry>,
    cache: State<'_, ThumbnailCacheManager>,
    resource_key: String,
) -> Result<bool, RepresentationCommandError> {
    if resource_key.trim().is_empty() {
        return Err(RepresentationCommandError::invalid_request(
            "resourceKey must not be empty",
        ));
    }

    let release_result = resources.release_derived(&resource_key);
    if let Err(error) = cache.release(&resource_key) {
        eprintln!("failed to release thumbnail cache lease for {resource_key}: {error}");
    }
    release_result.map_err(map_registry_error)
}

fn generate_thumbnail_representation(
    resources: MediaResourceRegistry,
    cache: ThumbnailCacheManager,
    resource_key: String,
    cache_root: PathBuf,
    spec: ThumbnailSpec,
    cancellation: ThumbnailCancellationToken,
) -> Result<ThumbnailRepresentationDto, RepresentationCommandError> {
    if cancellation.is_cancelled() {
        return Err(RepresentationCommandError::cancelled());
    }

    let source = resources.resolve(&resource_key).ok_or_else(|| {
        RepresentationCommandError::unavailable("resource key is not active or registered")
    })?;
    let cache_path = thumbnail_cache_path(&cache_root, &source, spec)?;
    let newly_generated = !cache_path.exists();
    let info = ImageThumbnailer
        .ensure_png_cancellable(&source, &cache_path, spec, &cancellation)
        .map_err(map_thumbnail_error)?;
    if cancellation.is_cancelled() {
        return Err(RepresentationCommandError::cancelled());
    }

    let thumbnail_key = resources
        .register_derived(&resource_key, cache_path.clone())
        .map_err(map_registry_error)?;
    if cancellation.is_cancelled() {
        let _ = resources.release_derived(&thumbnail_key);
        return Err(RepresentationCommandError::cancelled());
    }

    if let Err(error) =
        cache.register_and_maintain(&thumbnail_key, &cache_path, &cache_root, newly_generated)
    {
        // Cache maintenance is deliberately best-effort. The cached file is an
        // optimization, so maintenance failure must not make browsing fail.
        eprintln!("thumbnail cache maintenance failed: {error}");
    }

    if cancellation.is_cancelled() {
        let _ = resources.release_derived(&thumbnail_key);
        let _ = cache.release(&thumbnail_key);
        return Err(RepresentationCommandError::cancelled());
    }

    Ok(ThumbnailRepresentationDto {
        resource_key: thumbnail_key,
        width: info.width,
        height: info.height,
    })
}

fn thumbnail_cache_path(
    cache_root: &Path,
    source: &Path,
    spec: ThumbnailSpec,
) -> Result<PathBuf, RepresentationCommandError> {
    let metadata = fs::metadata(source).map_err(|error| {
        RepresentationCommandError::unavailable(format!("source metadata unavailable: {error}"))
    })?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);

    let mut hasher = Sha256::new();
    hasher.update(THUMBNAIL_CACHE_VERSION);
    hasher.update([0]);
    hasher.update(source.to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified_nanos.to_le_bytes());
    hasher.update(spec.max_edge.to_le_bytes());
    let digest = hasher.finalize();

    let mut file_name = String::with_capacity(digest.len() * 2 + 4);
    for byte in digest {
        write!(&mut file_name, "{byte:02x}").expect("writing to String cannot fail");
    }
    file_name.push_str(".png");
    Ok(cache_root.join(file_name))
}

fn map_thumbnail_error(error: ThumbnailError) -> RepresentationCommandError {
    match error {
        ThumbnailError::InvalidSpec(message) => {
            RepresentationCommandError::invalid_request(message)
        }
        ThumbnailError::Unsupported(message) => RepresentationCommandError::unsupported(message),
        ThumbnailError::Decode(message) => RepresentationCommandError::unsupported(message),
        ThumbnailError::Cancelled => RepresentationCommandError::cancelled(),
        ThumbnailError::Io(error) => RepresentationCommandError::internal(error.to_string()),
    }
}

fn map_registry_error(error: ResourceRegistryError) -> RepresentationCommandError {
    match error {
        ResourceRegistryError::InactiveSession | ResourceRegistryError::UnknownResource => {
            RepresentationCommandError::unavailable(error.to_string())
        }
        ResourceRegistryError::NotDerivedResource => {
            RepresentationCommandError::invalid_request(error.to_string())
        }
        _ => RepresentationCommandError::internal(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn cache_key_changes_with_size_mtime_or_requested_edge() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.jpg");
        let cache = dir.path().join("cache");
        fs::write(&source, b"abc").unwrap();

        let first =
            thumbnail_cache_path(&cache, &source, ThumbnailSpec::new(256).unwrap()).unwrap();
        let other_edge =
            thumbnail_cache_path(&cache, &source, ThumbnailSpec::new(512).unwrap()).unwrap();
        assert_ne!(first, other_edge);

        let mut file = fs::OpenOptions::new().append(true).open(&source).unwrap();
        file.write_all(b"def").unwrap();
        file.sync_all().unwrap();
        let changed =
            thumbnail_cache_path(&cache, &source, ThumbnailSpec::new(256).unwrap()).unwrap();
        assert_ne!(first, changed);
        assert_eq!(
            first.extension().and_then(|value| value.to_str()),
            Some("png")
        );
    }
}
