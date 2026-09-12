use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

use tauri::http::{
    header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE},
    Request, Response, StatusCode,
};

pub const MEDIA_PROTOCOL: &str = "waterfall-media";

#[derive(Clone, Default)]
pub struct MediaResourceRegistry {
    inner: Arc<Mutex<ResourceRegistryState>>,
}

#[derive(Default)]
struct ResourceRegistryState {
    generation: u64,
    current: Option<SessionResources>,
}

struct SessionResources {
    session_id: String,
    generation: u64,
    root: PathBuf,
    next_key: u64,
    paths: HashMap<u64, PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceRegistryError {
    EmptySessionId,
    InvalidRelativePath,
    InactiveSession,
    ExhaustedKeys,
    Poisoned,
}

impl std::fmt::Display for ResourceRegistryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::EmptySessionId => "media resource session id must not be empty",
            Self::InvalidRelativePath => "media resource path must be a safe relative path",
            Self::InactiveSession => "media resource session is no longer active",
            Self::ExhaustedKeys => "media resource key space exhausted",
            Self::Poisoned => "media resource registry lock poisoned",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ResourceRegistryError {}

impl MediaResourceRegistry {
    pub fn begin_session(
        &self,
        session_id: &str,
        root: impl Into<PathBuf>,
    ) -> Result<(), ResourceRegistryError> {
        if session_id.trim().is_empty() {
            return Err(ResourceRegistryError::EmptySessionId);
        }

        let mut state = self
            .inner
            .lock()
            .map_err(|_| ResourceRegistryError::Poisoned)?;
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or(ResourceRegistryError::ExhaustedKeys)?;
        let generation = state.generation;
        state.current = Some(SessionResources {
            session_id: session_id.to_owned(),
            generation,
            root: root.into(),
            next_key: 0,
            paths: HashMap::new(),
        });
        Ok(())
    }

    pub fn register(
        &self,
        session_id: &str,
        relative_path: &str,
    ) -> Result<String, ResourceRegistryError> {
        let relative = safe_relative_path(relative_path)?;
        let mut state = self
            .inner
            .lock()
            .map_err(|_| ResourceRegistryError::Poisoned)?;
        let session = state
            .current
            .as_mut()
            .filter(|session| session.session_id == session_id)
            .ok_or(ResourceRegistryError::InactiveSession)?;

        let key = session.next_key;
        session.next_key = session
            .next_key
            .checked_add(1)
            .ok_or(ResourceRegistryError::ExhaustedKeys)?;
        session.paths.insert(key, session.root.join(relative));
        Ok(format!("{}/{}", session.generation, key))
    }

    pub fn resolve(&self, resource_key: &str) -> Option<PathBuf> {
        let (generation, key) = parse_resource_key(resource_key)?;
        let state = self.inner.lock().ok()?;
        let session = state.current.as_ref()?;
        if session.generation != generation {
            return None;
        }
        session.paths.get(&key).cloned()
    }
}

pub fn respond_to_media_request(
    registry: MediaResourceRegistry,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let resource_key = request.uri().path().trim_start_matches('/');
    let Some(path) = registry.resolve(resource_key) else {
        return empty_response(StatusCode::NOT_FOUND);
    };

    match read_response(
        &path,
        request
            .headers()
            .get(RANGE)
            .and_then(|value| value.to_str().ok()),
    ) {
        Ok(response) => response,
        Err(ReadResponseError::NotFound) => empty_response(StatusCode::NOT_FOUND),
        Err(ReadResponseError::InvalidRange(total)) => Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(ACCEPT_RANGES, "bytes")
            .header(CONTENT_RANGE, format!("bytes */{total}"))
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .expect("static media range response must be valid"),
        Err(ReadResponseError::Io) => empty_response(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ReadResponseError {
    NotFound,
    InvalidRange(u64),
    Io,
}

fn read_response(
    path: &Path,
    range_header: Option<&str>,
) -> Result<Response<Vec<u8>>, ReadResponseError> {
    let mut file = File::open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ReadResponseError::NotFound
        } else {
            ReadResponseError::Io
        }
    })?;
    let total = file.metadata().map_err(|_| ReadResponseError::Io)?.len();
    let range =
        parse_range(range_header, total).map_err(|_| ReadResponseError::InvalidRange(total))?;
    let content_type = content_type_for_path(path);

    match range {
        None => {
            let length = usize::try_from(total).map_err(|_| ReadResponseError::Io)?;
            let mut body = Vec::with_capacity(length);
            file.read_to_end(&mut body)
                .map_err(|_| ReadResponseError::Io)?;
            Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, content_type)
                .header(CONTENT_LENGTH, total.to_string())
                .header(ACCEPT_RANGES, "bytes")
                .header("Access-Control-Allow-Origin", "*")
                .body(body)
                .map_err(|_| ReadResponseError::Io)
        }
        Some((start, end)) => {
            let length_u64 = end - start + 1;
            let length = usize::try_from(length_u64).map_err(|_| ReadResponseError::Io)?;
            file.seek(SeekFrom::Start(start))
                .map_err(|_| ReadResponseError::Io)?;
            let mut body = vec![0; length];
            file.read_exact(&mut body)
                .map_err(|_| ReadResponseError::Io)?;
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(CONTENT_TYPE, content_type)
                .header(CONTENT_LENGTH, length_u64.to_string())
                .header(CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
                .header(ACCEPT_RANGES, "bytes")
                .header("Access-Control-Allow-Origin", "*")
                .body(body)
                .map_err(|_| ReadResponseError::Io)
        }
    }
}

fn empty_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_LENGTH, "0")
        .header(ACCEPT_RANGES, "bytes")
        .header("Access-Control-Allow-Origin", "*")
        .body(Vec::new())
        .expect("static empty media response must be valid")
}

fn safe_relative_path(value: &str) -> Result<PathBuf, ResourceRegistryError> {
    let path = Path::new(value);
    if value.trim().is_empty() || path.is_absolute() {
        return Err(ResourceRegistryError::InvalidRelativePath);
    }

    let mut safe = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => safe.push(segment),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ResourceRegistryError::InvalidRelativePath)
            }
        }
    }

    if safe.as_os_str().is_empty() {
        return Err(ResourceRegistryError::InvalidRelativePath);
    }
    Ok(safe)
}

fn parse_resource_key(value: &str) -> Option<(u64, u64)> {
    let mut parts = value.split('/');
    let generation = parts.next()?.parse().ok()?;
    let key = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((generation, key))
}

fn parse_range(value: Option<&str>, total: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.strip_prefix("bytes=").ok_or(())?;
    if value.contains(',') || total == 0 {
        return Err(());
    }

    let (start, end) = value.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix: u64 = end.parse().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let length = suffix.min(total);
        return Ok(Some((total - length, total - 1)));
    }

    let start: u64 = start.parse().map_err(|_| ())?;
    if start >= total {
        return Err(());
    }

    if end.is_empty() {
        return Ok(Some((start, total - 1)));
    }

    let requested_end: u64 = end.parse().map_err(|_| ())?;
    if requested_end < start {
        return Err(());
    }
    Ok(Some((start, requested_end.min(total - 1))))
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("tif" | "tiff") => "image/tiff",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        Some("mp3") => "audio/mpeg",
        Some("ogg" | "oga") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("m4a") => "audio/mp4",
        Some("flac") => "audio/flac",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_uses_opaque_generation_keys_and_invalidates_old_sessions() {
        let registry = MediaResourceRegistry::default();
        registry.begin_session("s1", "/media/one").unwrap();
        let first = registry.register("s1", "nested/a.jpg").unwrap();
        assert_eq!(first, "1/0");
        assert_eq!(
            registry.resolve(&first),
            Some(PathBuf::from("/media/one/nested/a.jpg"))
        );

        registry.begin_session("s2", "/media/two").unwrap();
        assert_eq!(registry.resolve(&first), None);
        assert_eq!(
            registry.register("s1", "late.jpg"),
            Err(ResourceRegistryError::InactiveSession)
        );
        let second = registry.register("s2", "b.jpg").unwrap();
        assert_eq!(second, "2/0");
    }

    #[test]
    fn registry_rejects_unsafe_relative_paths() {
        let registry = MediaResourceRegistry::default();
        registry.begin_session("s1", "/media").unwrap();
        for path in ["", "../secret.jpg", "/absolute.jpg", "a/../../secret.jpg"] {
            assert_eq!(
                registry.register("s1", path),
                Err(ResourceRegistryError::InvalidRelativePath)
            );
        }
    }

    #[test]
    fn parses_single_byte_ranges() {
        assert_eq!(parse_range(None, 100), Ok(None));
        assert_eq!(parse_range(Some("bytes=10-19"), 100), Ok(Some((10, 19))));
        assert_eq!(parse_range(Some("bytes=90-"), 100), Ok(Some((90, 99))));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Ok(Some((90, 99))));
        assert_eq!(parse_range(Some("bytes=90-999"), 100), Ok(Some((90, 99))));
    }

    #[test]
    fn rejects_invalid_or_multi_ranges() {
        for value in [
            "items=0-1",
            "bytes=100-101",
            "bytes=20-10",
            "bytes=0-1,3-4",
            "bytes=-0",
        ] {
            assert_eq!(parse_range(Some(value), 100), Err(()));
        }
        assert_eq!(parse_range(Some("bytes=0-0"), 0), Err(()));
    }

    #[test]
    fn maps_common_media_mime_types() {
        assert_eq!(content_type_for_path(Path::new("a.JPG")), "image/jpeg");
        assert_eq!(content_type_for_path(Path::new("a.webp")), "image/webp");
        assert_eq!(content_type_for_path(Path::new("a.mp4")), "video/mp4");
        assert_eq!(content_type_for_path(Path::new("a.flac")), "audio/flac");
        assert_eq!(
            content_type_for_path(Path::new("a.unknown")),
            "application/octet-stream"
        );
    }
}
