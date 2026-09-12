use std::{error::Error, fmt};

use crate::{MediaKind, VisualMetadata};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MediaFileFingerprint {
    pub file_size: u64,
    pub modified_at_unix_ns: Option<u128>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataReadFailure {
    message: String,
}

impl MetadataReadFailure {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for MetadataReadFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for MetadataReadFailure {}

/// Reads layout-critical visual metadata without requiring a full media decode.
///
/// `locator` is adapter-specific opaque data from the core's point of view.
pub trait VisualMetadataReader: Send + Sync {
    fn read_visual_metadata(
        &self,
        locator: &str,
        kind: &MediaKind,
    ) -> Result<Option<VisualMetadata>, MetadataReadFailure>;

    /// Reads visual metadata with an optional file fingerprint already obtained
    /// by the caller. Readers that do not need it can rely on this default.
    fn read_visual_metadata_with_fingerprint(
        &self,
        locator: &str,
        kind: &MediaKind,
        _fingerprint: Option<MediaFileFingerprint>,
    ) -> Result<Option<VisualMetadata>, MetadataReadFailure> {
        self.read_visual_metadata(locator, kind)
    }
}
