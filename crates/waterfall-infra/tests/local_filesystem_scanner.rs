use std::{
    fs,
    sync::atomic::{AtomicBool, Ordering},
};

use tempfile::tempdir;
use waterfall_core::{
    CancellationProbe, MediaScanner, MediaSource, ScanEvent, ScanEventSink, ScanFailure,
    ScanRequest, SourceId, VisualMetadata,
};
use waterfall_infra::LocalFilesystemScanner;

#[derive(Default)]
struct RecordingSink {
    events: Vec<ScanEvent>,
}

impl ScanEventSink for RecordingSink {
    fn emit(&mut self, event: ScanEvent) -> Result<(), ScanFailure> {
        self.events.push(event);
        Ok(())
    }
}

struct TestCancellation(AtomicBool);

impl TestCancellation {
    fn new(cancelled: bool) -> Self {
        Self(AtomicBool::new(cancelled))
    }
}

impl CancellationProbe for TestCancellation {
    fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

#[test]
fn recursively_scans_supported_media_and_emits_batches() {
    let directory = tempdir().expect("temp directory");
    let nested = directory.path().join("nested");
    fs::create_dir(&nested).expect("nested directory");

    fs::write(directory.path().join("photo.jpg"), b"jpg").expect("photo");
    fs::write(nested.join("clip.mp4"), b"video").expect("video");
    fs::write(nested.join("sound.flac"), b"audio").expect("audio");
    fs::write(directory.path().join("notes.txt"), b"ignored").expect("text");

    let request = ScanRequest::new(
        "session-1",
        MediaSource::new(
            SourceId::new("source-1"),
            directory.path().to_string_lossy().into_owned(),
        ),
        2,
    );

    let mut sink = RecordingSink::default();
    LocalFilesystemScanner::new()
        .scan(&request, &mut sink, &TestCancellation::new(false))
        .expect("scan succeeds");

    assert!(matches!(
        sink.events.first(),
        Some(ScanEvent::Started { .. })
    ));

    let batches: Vec<_> = sink
        .events
        .iter()
        .filter_map(|event| match event {
            ScanEvent::Batch { items, .. } => Some(items),
            _ => None,
        })
        .collect();

    assert_eq!(batches.len(), 2);
    assert_eq!(batches.iter().map(|batch| batch.len()).sum::<usize>(), 3);

    let mut paths: Vec<_> = batches
        .iter()
        .flat_map(|batch| batch.iter().map(|item| item.relative_path.as_str()))
        .collect();
    paths.sort_unstable();
    assert_eq!(
        paths,
        vec!["nested/clip.mp4", "nested/sound.flac", "photo.jpg"]
    );

    let finished = sink.events.iter().find_map(|event| match event {
        ScanEvent::Finished { summary, .. } => Some(summary),
        _ => None,
    });
    let summary = finished.expect("finished event");
    assert_eq!(summary.discovered_files, 4);
    assert_eq!(summary.accepted_media, 3);
    assert_eq!(summary.emitted_batches, 2);
}

#[test]
fn populates_visual_metadata_from_image_header_without_full_decode() {
    let directory = tempdir().expect("temp directory");
    let mut png_header = vec![0; 24];
    png_header[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    png_header[12..16].copy_from_slice(b"IHDR");
    png_header[16..20].copy_from_slice(&2560u32.to_be_bytes());
    png_header[20..24].copy_from_slice(&1440u32.to_be_bytes());
    fs::write(directory.path().join("header-only.png"), png_header).expect("png header");

    let request = ScanRequest::new(
        "session-metadata",
        MediaSource::new(
            SourceId::new("source-1"),
            directory.path().to_string_lossy().into_owned(),
        ),
        16,
    );
    let mut sink = RecordingSink::default();

    LocalFilesystemScanner::new()
        .scan(&request, &mut sink, &TestCancellation::new(false))
        .expect("scan succeeds");

    let item = sink.events.iter().find_map(|event| match event {
        ScanEvent::Batch { items, .. } => items.first(),
        _ => None,
    });

    assert_eq!(
        item.expect("scanned image").visual,
        Some(VisualMetadata {
            width: 2560,
            height: 1440
        })
    );
}

#[test]
fn populates_visual_metadata_from_video_container_without_frame_decode() {
    let directory = tempdir().expect("temp directory");
    let tkhd = iso_box(*b"tkhd", tkhd_payload(1920, 1080));
    let hdlr = iso_box(*b"hdlr", hdlr_payload(*b"vide"));
    let mdia = iso_box(*b"mdia", hdlr);
    let trak = iso_box(*b"trak", [tkhd, mdia].concat());
    let moov = iso_box(*b"moov", trak);
    let mdat = iso_box(*b"mdat", vec![0x55; 1024]);
    let bytes = [mdat, moov].concat();
    fs::write(directory.path().join("header-only.mp4"), bytes).expect("mp4 container");

    let request = ScanRequest::new(
        "session-video-metadata",
        MediaSource::new(
            SourceId::new("source-1"),
            directory.path().to_string_lossy().into_owned(),
        ),
        16,
    );
    let mut sink = RecordingSink::default();

    LocalFilesystemScanner::new()
        .scan(&request, &mut sink, &TestCancellation::new(false))
        .expect("scan succeeds");

    let item = sink.events.iter().find_map(|event| match event {
        ScanEvent::Batch { items, .. } => items.first(),
        _ => None,
    });

    assert_eq!(
        item.expect("scanned video").visual,
        Some(VisualMetadata {
            width: 1920,
            height: 1080,
        })
    );
}

#[test]
fn cancellation_finishes_with_cancelled_event() {
    let directory = tempdir().expect("temp directory");
    fs::write(directory.path().join("photo.jpg"), b"jpg").expect("photo");

    let request = ScanRequest::new(
        "session-1",
        MediaSource::new(
            SourceId::new("source-1"),
            directory.path().to_string_lossy().into_owned(),
        ),
        16,
    );

    let mut sink = RecordingSink::default();
    LocalFilesystemScanner::new()
        .scan(&request, &mut sink, &TestCancellation::new(true))
        .expect("cancellation is not an error");

    assert!(matches!(
        sink.events.first(),
        Some(ScanEvent::Started { .. })
    ));
    assert!(sink
        .events
        .iter()
        .any(|event| matches!(event, ScanEvent::Cancelled { .. })));
    assert!(!sink
        .events
        .iter()
        .any(|event| matches!(event, ScanEvent::Finished { .. })));
}

fn iso_box(kind: [u8; 4], payload: Vec<u8>) -> Vec<u8> {
    let size = 8usize.checked_add(payload.len()).expect("box size");
    let mut output = Vec::with_capacity(size);
    output.extend_from_slice(&(size as u32).to_be_bytes());
    output.extend_from_slice(&kind);
    output.extend_from_slice(&payload);
    output
}

fn tkhd_payload(width: u32, height: u32) -> Vec<u8> {
    let mut payload = vec![0u8; 44];
    payload[0..4].copy_from_slice(&(1i32 << 16).to_be_bytes());
    payload[16..20].copy_from_slice(&(1i32 << 16).to_be_bytes());
    payload[32..36].copy_from_slice(&(1i32 << 30).to_be_bytes());
    payload[36..40].copy_from_slice(&(width << 16).to_be_bytes());
    payload[40..44].copy_from_slice(&(height << 16).to_be_bytes());
    payload
}

fn hdlr_payload(handler: [u8; 4]) -> Vec<u8> {
    let mut payload = vec![0u8; 24];
    payload[8..12].copy_from_slice(&handler);
    payload
}
