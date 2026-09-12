use serde::{Deserialize, Serialize};

use crate::{MediaItem, MediaSource, ScanSessionId};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ScanRequest {
    pub session_id: ScanSessionId,
    pub source: MediaSource,
    pub batch_size: usize,
}

impl ScanRequest {
    pub fn new(
        session_id: impl Into<ScanSessionId>,
        source: MediaSource,
        batch_size: usize,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            source,
            batch_size,
        }
    }

    pub fn validate(&self) -> Result<(), ScanFailure> {
        if self.batch_size == 0 {
            return Err(ScanFailure::invalid_request(
                "scan batch_size must be greater than zero",
            ));
        }

        if self.source.locator.trim().is_empty() {
            return Err(ScanFailure::invalid_request(
                "media source locator must not be empty",
            ));
        }

        Ok(())
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ScanSummary {
    pub discovered_files: u64,
    pub accepted_media: u64,
    pub emitted_batches: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ScanWarning {
    pub path: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ScanEvent {
    Started {
        session_id: ScanSessionId,
    },
    Batch {
        session_id: ScanSessionId,
        items: Vec<MediaItem>,
    },
    Warning {
        session_id: ScanSessionId,
        warning: ScanWarning,
    },
    Finished {
        session_id: ScanSessionId,
        summary: ScanSummary,
    },
    Cancelled {
        session_id: ScanSessionId,
        summary: ScanSummary,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScanFailureKind {
    InvalidRequest,
    SourceUnavailable,
    SinkClosed,
    Internal,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ScanFailure {
    pub kind: ScanFailureKind,
    pub message: String,
}

impl ScanFailure {
    pub fn new(kind: ScanFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(ScanFailureKind::InvalidRequest, message)
    }

    pub fn source_unavailable(message: impl Into<String>) -> Self {
        Self::new(ScanFailureKind::SourceUnavailable, message)
    }

    pub fn sink_closed(message: impl Into<String>) -> Self {
        Self::new(ScanFailureKind::SinkClosed, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ScanFailureKind::Internal, message)
    }
}

impl std::fmt::Display for ScanFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for ScanFailure {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SourceId;

    #[test]
    fn rejects_zero_batch_size() {
        let request = ScanRequest::new(
            "session-1",
            MediaSource::new(SourceId::new("source-1"), "/tmp/media"),
            0,
        );

        let error = request.validate().expect_err("zero batch size must fail");
        assert_eq!(error.kind, ScanFailureKind::InvalidRequest);
    }

    #[test]
    fn rejects_empty_source_locator() {
        let request = ScanRequest::new(
            "session-1",
            MediaSource::new(SourceId::new("source-1"), "   "),
            16,
        );

        let error = request.validate().expect_err("empty locator must fail");
        assert_eq!(error.kind, ScanFailureKind::InvalidRequest);
    }
}
