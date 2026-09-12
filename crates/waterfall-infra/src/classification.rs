use std::path::Path;

use waterfall_core::MediaKind;

pub fn classify_path(path: &Path) -> Option<MediaKind> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();

    match extension.as_str() {
        "gif" => Some(MediaKind::AnimatedImage),
        "jpg" | "jpeg" | "png" | "bmp" | "webp" | "avif" | "tif" | "tiff" => {
            Some(MediaKind::Image)
        }
        "mp4" | "m4v" | "mov" | "mkv" | "webm" | "avi" => Some(MediaKind::Video),
        "mp3" | "flac" | "wav" | "ogg" | "opus" | "m4a" | "aac" => {
            Some(MediaKind::Audio)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_is_case_insensitive() {
        assert_eq!(
            classify_path(Path::new("PHOTO.JPEG")),
            Some(MediaKind::Image)
        );
        assert_eq!(classify_path(Path::new("clip.MP4")), Some(MediaKind::Video));
    }

    #[test]
    fn unsupported_files_are_ignored() {
        assert_eq!(classify_path(Path::new("notes.txt")), None);
        assert_eq!(classify_path(Path::new("no-extension")), None);
    }
}
