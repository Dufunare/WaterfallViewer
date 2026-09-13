use serde::{Deserialize, Serialize};

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self::new(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self::new(value)
            }
        }
    };
}

string_id!(MediaId);
string_id!(SourceId);
string_id!(ScanSessionId);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaKind {
    Image,
    AnimatedImage,
    Video,
    Audio,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct VisualMetadata {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MediaDetail {
    Video(VideoDetail),
    Audio(AudioDetail),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Default)]
pub struct VideoDetail {
    pub duration_ms: Option<u64>,
    pub codec: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Default)]
pub struct AudioDetail {
    pub duration_ms: Option<u64>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub codec: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MediaItem {
    pub id: MediaId,
    pub source_id: SourceId,
    pub name: String,
    pub relative_path: String,
    pub kind: MediaKind,
    pub file_size: u64,
    pub modified_at_ms: Option<u64>,
    pub visual: Option<VisualMetadata>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MediaSource {
    pub id: SourceId,
    /// Adapter-specific source locator. The core treats it as opaque data.
    pub locator: String,
}

impl MediaSource {
    pub fn new(id: impl Into<SourceId>, locator: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            locator: locator.into(),
        }
    }
}
