use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
};

use waterfall_infra::ThumbnailCancellationToken;

const MAX_PENDING_CANCELLATIONS: usize = 256;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ThumbnailRequestTelemetrySnapshot {
    pub active_requests: u64,
    pub cancelled_active_requests: u64,
    pub pending_cancellations: u64,
}

#[derive(Clone, Default)]
pub struct ThumbnailRequestRegistry {
    inner: Arc<Mutex<ThumbnailRequestState>>,
}

#[derive(Default)]
struct ThumbnailRequestState {
    active: HashMap<String, ThumbnailCancellationToken>,
    pending_cancellations: HashSet<String>,
    pending_order: VecDeque<String>,
}

impl ThumbnailRequestRegistry {
    /// Register a backend request and return its cancellation token.
    ///
    /// Cancellation commands can race ahead of the request invoke across the
    /// WebView/Tauri boundary. A bounded set of pre-cancellation tombstones
    /// makes that race deterministic without retaining unbounded request IDs.
    pub fn register(&self, request_id: &str) -> Result<ThumbnailCancellationToken, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "thumbnail request registry lock poisoned".to_owned())?;
        if state.active.contains_key(request_id) {
            return Err("thumbnail request id is already active".to_owned());
        }

        let token = ThumbnailCancellationToken::default();
        if state.pending_cancellations.remove(request_id) {
            token.cancel();
        }
        state.active.insert(request_id.to_owned(), token.clone());
        Ok(token)
    }

    /// Cancel an active request, or remember a bounded pre-cancellation if the
    /// request command has not registered yet. Returns whether an active token
    /// was found at the time of cancellation.
    pub fn cancel(&self, request_id: &str) -> Result<bool, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "thumbnail request registry lock poisoned".to_owned())?;
        if let Some(token) = state.active.get(request_id) {
            token.cancel();
            return Ok(true);
        }

        if state.pending_cancellations.insert(request_id.to_owned()) {
            state.pending_order.push_back(request_id.to_owned());
        }
        while state.pending_cancellations.len() > MAX_PENDING_CANCELLATIONS {
            let Some(oldest) = state.pending_order.pop_front() else {
                break;
            };
            state.pending_cancellations.remove(&oldest);
        }
        Ok(false)
    }

    pub fn finish(&self, request_id: &str) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "thumbnail request registry lock poisoned".to_owned())?;
        state.active.remove(request_id);
        Ok(())
    }

    pub fn telemetry_snapshot(&self) -> Result<ThumbnailRequestTelemetrySnapshot, String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "thumbnail request registry lock poisoned".to_owned())?;
        let cancelled_active_requests = state
            .active
            .values()
            .filter(|token| token.is_cancelled())
            .count() as u64;
        Ok(ThumbnailRequestTelemetrySnapshot {
            active_requests: state.active.len() as u64,
            cancelled_active_requests,
            pending_cancellations: state.pending_cancellations.len() as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancels_active_request_token() {
        let registry = ThumbnailRequestRegistry::default();
        let token = registry.register("request-1").unwrap();

        assert!(!token.is_cancelled());
        assert!(registry.cancel("request-1").unwrap());
        assert!(token.is_cancelled());
        assert_eq!(
            registry.telemetry_snapshot().unwrap(),
            ThumbnailRequestTelemetrySnapshot {
                active_requests: 1,
                cancelled_active_requests: 1,
                pending_cancellations: 0,
            }
        );
        registry.finish("request-1").unwrap();
        assert_eq!(
            registry.telemetry_snapshot().unwrap(),
            ThumbnailRequestTelemetrySnapshot::default()
        );
    }

    #[test]
    fn cancellation_before_registration_is_observed() {
        let registry = ThumbnailRequestRegistry::default();

        assert!(!registry.cancel("request-1").unwrap());
        assert_eq!(registry.telemetry_snapshot().unwrap().pending_cancellations, 1);
        let token = registry.register("request-1").unwrap();
        assert!(token.is_cancelled());
        let snapshot = registry.telemetry_snapshot().unwrap();
        assert_eq!(snapshot.active_requests, 1);
        assert_eq!(snapshot.cancelled_active_requests, 1);
        assert_eq!(snapshot.pending_cancellations, 0);
        registry.finish("request-1").unwrap();
    }

    #[test]
    fn duplicate_active_request_ids_are_rejected() {
        let registry = ThumbnailRequestRegistry::default();
        registry.register("request-1").unwrap();

        assert!(registry.register("request-1").is_err());
    }

    #[test]
    fn pending_cancellations_are_bounded() {
        let registry = ThumbnailRequestRegistry::default();
        for index in 0..(MAX_PENDING_CANCELLATIONS + 32) {
            registry.cancel(&format!("request-{index}")).unwrap();
        }

        let state = registry.inner.lock().unwrap();
        assert_eq!(state.pending_cancellations.len(), MAX_PENDING_CANCELLATIONS);
        assert!(!state.pending_cancellations.contains("request-0"));
        drop(state);
        assert_eq!(
            registry.telemetry_snapshot().unwrap().pending_cancellations,
            MAX_PENDING_CANCELLATIONS as u64
        );
    }
}
