use crate::{ScanEvent, ScanFailure, ScanRequest};

pub trait ScanEventSink {
    fn emit(&mut self, event: ScanEvent) -> Result<(), ScanFailure>;
}

pub trait CancellationProbe: Send + Sync {
    fn is_cancelled(&self) -> bool;
}

pub trait MediaScanner {
    fn scan(
        &self,
        request: &ScanRequest,
        sink: &mut dyn ScanEventSink,
        cancellation: &dyn CancellationProbe,
    ) -> Result<(), ScanFailure>;
}
