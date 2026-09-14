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
    thumbnail_cache::{ThumbnailCacheManager, ThumbnailCacheTelemetrySnapshot},
    thumbnail_request::ThumbnailRequestRegistry,
};

const THUMBNAIL_CACHE_VERSION: &[u8] = b"waterfall-thumbnail-v2";
const DIRECT_SOURCE_MAX_BYTES: u64 = 16 * 1024 * 1024;
const DIRECT_SOURCE_MAX_PIXELS: u64 = 16_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ThumbnailCacheEncoding {
    Png,
    Jpeg,
}

impl ThumbnailCacheEncoding {
    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailRepresentationDto {
    resource_key: String,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailCacheTelemetryDto {
    generated_registrations: u64,
    reused_registrations: u64,
    active_resource_keys: u64,
    active_registrations: u64,
    maintenance_runs: u64,
    maintenance_failures: u64,
    removed_files: u64,
    removed_bytes: u64,
    last_observed_cache_bytes: u64,
}

impl From<ThumbnailCacheTelemetrySnapshot> for ThumbnailCacheTelemetryDto {
    fn from(snapshot: ThumbnailCacheTelemetrySnapshot) -> Self {
        Self {
            generated_registrations: snapshot.generated_registrations,
            reused_registrations: snapshot.reused_registrations,
            active_resource_keys: snapshot.active_resource_keys,
            active_registrations: snapshot.active_registrations,
            maintenance_runs: snapshot.maintenance_runs,
            maintenance_failures: snapshot.maintenance_failures,
            removed_files: snapshot.removed_files,
            removed_bytes: snapshot.removed_bytes,
            last_observed_cache_bytes: snapshot.last_observed_cache_bytes,
        }
    }
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
        .join("v2");
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
pub fn get_thumbnail_cache_telemetry(
    cache: State<'_, ThumbnailCacheManager>,
) -> Result<ThumbnailCacheTelemetryDto, RepresentationCommandError> {
    cache
        .telemetry_snapshot()
        .map(ThumbnailCacheTelemetryDto::from)
        .map_err(RepresentationCommandError::internal)
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

    match resources.release_derived(&resource_key) {
        Ok(removed) => {
            if let Err(error) = cache.release(&resource_key) {
                eprintln!("failed to release thumbnail cache lease for {resource_key}: {error}");
            }
            Ok(removed)
        }
        // The fast path deliberately returns an existing source resource key.
        // Source resources belong to the media session rather than a thumbnail
        // lease, so releasing that representation is a no-op.
        Err(ResourceRegistryError::NotDerivedResource) => Ok(false),
        Err(error) => Err(map_registry_error(error)),
    }
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

    if let Some(representation) = direct_source_representation(
        &source,
        &resource_key,
        &cancellation,
    )? {
        return Ok(representation);
    }

    let encoding = thumbnail_cache_encoding(&source);
    let cache_path = thumbnail_cache_path(&cache_root, &source, spec, encoding)?;
    let newly_generated = !cache_path.exists();
    let thumbnailer = ImageThumbnailer;
    let info = match encoding {
        ThumbnailCacheEncoding::Jpeg => thumbnailer.ensure_jpeg_cancellable(
            &source,
            &cache_path,
            spec,
            &cancellation,
        ),
        ThumbnailCacheEncoding::Png => thumbnailer.ensure_png_cancellable(
            &source,
            &cache_path,
            spec,
            &cancellation,
        ),
    }
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

fn direct_source_representation(
    source: &Path,
    resource_key: &str,
    cancellation: &ThumbnailCancellationToken,
) -> Result<Option<ThumbnailRepresentationDto>, RepresentationCommandError> {
    if !supports_direct_source(source) {
        return Ok(None);
    }
    let metadata = fs::metadata(source).map_err(|error| {
        RepresentationCommandError::unavailable(format!("source metadata unavailable: {error}"))
    })?;
    if metadata.len() > DIRECT_SOURCE_MAX_BYTES {
        return Ok(None);
    }
    if cancellation.is_cancelled() {
        return Err(RepresentationCommandError::cancelled());
    }

    let info = ImageThumbnailer
        .source_dimensions(source)
        .map_err(map_thumbnail_error)?;
    let pixels = u64::from(info.width).saturating_mul(u64::from(info.height));
    if pixels > DIRECT_SOURCE_MAX_PIXELS {
        return Ok(None);
    }
    if cancellation.is_cancelled() {
        return Err(RepresentationCommandError::cancelled());
    }

    Ok(Some(ThumbnailRepresentationDto {
        resource_key: resource_key.to_owned(),
        width: info.width,
        height: info.height,
    }))
}

fn supports_direct_source(source: &Path) -> bool {
    matches!(
        source
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("jpg" | "jpeg" | "png" | "bmp")
    )
}

fn thumbnail_cache_encoding(source: &Path) -> ThumbnailCacheEncoding {
    match source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg") => ThumbnailCacheEncoding::Jpeg,
        _ => ThumbnailCacheEncoding::Png,
    }
}

fn thumbnail_cache_path(
    cache_root: &Path,
    source: &Path,
    spec: ThumbnailSpec,
    encoding: ThumbnailCacheEncoding,
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
    hasher.update([match encoding {
        ThumbnailCacheEncoding::Png => 0,
        ThumbnailCacheEncoding::Jpeg => 1,
    }]);
    let digest = hasher.finalize();

    let mut file_name = String::with_capacity(digest.len() * 2 + 4);
    for byte in digest {
        write!(&mut file_name, "{byte:02x}").expect("writing to String cannot fail");
    }
    file_name.push('.');
    file_name.push_str(encoding.extension());
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
    fn direct_source_extensions_are_conservative() {
        assert!(supports_direct_source(Path::new("photo.jpg")));
        assert!(supports_direct_source(Path::new("photo.JPEG")));
        assert!(supports_direct_source(Path::new("graphic.png")));
        assert!(supports_direct_source(Path::new("bitmap.bmp")));
        assert!(!supports_direct_source(Path::new("animated.gif")));
        assert!(!supports_direct_source(Path::new("photo.webp")));
        assert!(!supports_direct_source(Path::new("scan.tiff")));
    }

    #[test]
    fn cache_key_changes_with_size_mtime_or_requested_edge() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.jpg");
        let cache = dir.path().join("cache");
        fs::write(&source, b"abc").unwrap();
        let encoding = thumbnail_cache_encoding(&source);

        let first = thumbnail_cache_path(
            &cache,
            &source,
            ThumbnailSpec::new(256).unwrap(),
            encoding,
        )
        .unwrap();
        let other_edge = thumbnail_cache_path(
            &cache,
            &source,
            ThumbnailSpec::new(512).unwrap(),
            encoding,
        )
        .unwrap();
        assert_ne!(first, other_edge);

        let mut file = fs::OpenOptions::new().append(true).open(&source).unwrap();
        file.write_all(b"def").unwrap();
        file.sync_all().unwrap();
        let changed = thumbnail_cache_path(
            &cache,
            &source,
            ThumbnailSpec::new(256).unwrap(),
            encoding,
        )
        .unwrap();
        assert_ne!(first, changed);
        assert_eq!(first.extension().and_then(|value| value.to_str()), Some("jpg"));
    }

    #[test]
    fn transparent_capable_sources_keep_png_cache_representation() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.png");
        fs::write(&source, b"abc").unwrap();
        let path = thumbnail_cache_path(
            &dir.path().join("cache"),
            &source,
            ThumbnailSpec::new(256).unwrap(),
            thumbnail_cache_encoding(&source),
        )
        .unwrap();
        assert_eq!(path.extension().and_then(|value| value.to_str()), Some("png"));
    }
}
