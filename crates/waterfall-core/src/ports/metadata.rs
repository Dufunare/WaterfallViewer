use std::{error::Error, fmt};

use crate::{MediaKind, VisualMetadata};

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
}
