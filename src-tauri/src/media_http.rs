use std::{
    fs::File,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::Path,
    sync::Arc,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};
use tauri::State;

use crate::media_resource::MediaResourceRegistry;

#[derive(Clone)]
pub struct MediaHttpServer {
    origin: Arc<str>,
}

impl MediaHttpServer {
    pub fn start(registry: MediaResourceRegistry) -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let address = listener.local_addr()?;
        let token = make_session_token(address);
        let origin: Arc<str> = format!("http://127.0.0.1:{}/{token}", address.port()).into();
        let worker_token = token.clone();

        thread::Builder::new()
            .name("waterfall-media-http".to_owned())
            .spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else {
                        continue;
                    };
                    let registry = registry.clone();
                    let token = worker_token.clone();
                    let _ = thread::Builder::new()
                        .name("waterfall-media-http-client".to_owned())
                        .spawn(move || {
                            let _ = serve_connection(stream, registry, &token);
                        });
                }
            })?;

        Ok(Self { origin })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }
}

#[tauri::command]
pub fn get_media_http_origin(server: State<'_, MediaHttpServer>) -> String {
    server.origin().to_owned()
}

fn serve_connection(
    stream: TcpStream,
    registry: MediaResourceRegistry,
    token: &str,
) -> io::Result<()> {
    stream.set_nodelay(true)?;
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let _version = parts.next().unwrap_or_default();

    let mut range_header: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("range") {
                range_header = Some(value.trim().to_owned());
            }
        }
    }

    let mut stream = reader.into_inner();
    if method != "GET" && method != "HEAD" {
        return write_empty_response(&mut stream, 405, "Method Not Allowed");
    }

    let path_only = target.split('?').next().unwrap_or(target);
    let expected_prefix = format!("/{token}/");
    let Some(resource_key) = path_only.strip_prefix(&expected_prefix) else {
        return write_empty_response(&mut stream, 404, "Not Found");
    };
    if !is_opaque_resource_key(resource_key) {
        return write_empty_response(&mut stream, 404, "Not Found");
    }

    let Some(path) = registry.resolve(resource_key) else {
        return write_empty_response(&mut stream, 404, "Not Found");
    };

    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return write_empty_response(&mut stream, 404, "Not Found")
        }
        Err(_) => return write_empty_response(&mut stream, 500, "Internal Server Error"),
    };
    let total = file.metadata()?.len();
    let range = match parse_range(range_header.as_deref(), total) {
        Ok(range) => range,
        Err(()) => {
            write!(
                stream,
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
            )?;
            return stream.flush();
        }
    };

    let content_type = content_type_for_path(&path);
    let head_only = method == "HEAD";
    match range {
        None => {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {total}\r\nAccept-Ranges: bytes\r\nCache-Control: private, max-age=31536000, immutable\r\nAccess-Control-Allow-Origin: *\r\nCross-Origin-Resource-Policy: cross-origin\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
            )?;
            if !head_only {
                io::copy(&mut file, &mut stream)?;
            }
        }
        Some((start, end)) => {
            let length = end - start + 1;
            write!(
                stream,
                "HTTP/1.1 206 Partial Content\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nContent-Range: bytes {start}-{end}/{total}\r\nAccept-Ranges: bytes\r\nCache-Control: private, max-age=31536000, immutable\r\nAccess-Control-Allow-Origin: *\r\nCross-Origin-Resource-Policy: cross-origin\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
            )?;
            if !head_only {
                file.seek(SeekFrom::Start(start))?;
                let mut limited = file.take(length);
                io::copy(&mut limited, &mut stream)?;
            }
        }
    }
    stream.flush()
}

fn write_empty_response(stream: &mut TcpStream, status: u16, reason: &str) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()
}

fn is_opaque_resource_key(value: &str) -> bool {
    let mut parts = value.split('/');
    let generation = parts.next();
    let key = parts.next();
    generation.is_some_and(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && key.is_some_and(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none()
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

fn make_session_token(address: SocketAddr) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hasher = Sha256::new();
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(now.to_le_bytes());
    hasher.update(address.to_string().as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_resource_key_is_strict() {
        assert!(is_opaque_resource_key("1/0"));
        assert!(is_opaque_resource_key("123/456"));
        assert!(!is_opaque_resource_key("1"));
        assert!(!is_opaque_resource_key("1/2/3"));
        assert!(!is_opaque_resource_key("../1/2"));
        assert!(!is_opaque_resource_key("1/a"));
    }

    #[test]
    fn range_parser_supports_standard_single_ranges() {
        assert_eq!(parse_range(None, 100), Ok(None));
        assert_eq!(parse_range(Some("bytes=10-19"), 100), Ok(Some((10, 19))));
        assert_eq!(parse_range(Some("bytes=90-"), 100), Ok(Some((90, 99))));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Ok(Some((90, 99))));
        assert!(parse_range(Some("bytes=100-"), 100).is_err());
    }
}
