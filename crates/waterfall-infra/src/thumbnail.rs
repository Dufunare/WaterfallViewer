use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use image::{codecs::jpeg::JpegEncoder, ImageFormat, ImageReader, Limits};

const MAX_THUMBNAIL_EDGE: u32 = 4096;
const MAX_INPUT_DIMENSION: u32 = 65_535;
const MAX_DECODE_ALLOCATION: u64 = 256 * 1024 * 1024;
const JPEG_THUMBNAIL_QUALITY: u8 = 82;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ThumbnailSpec {
    pub max_edge: u32,
}

impl ThumbnailSpec {
    pub fn new(max_edge: u32) -> Result<Self, ThumbnailError> {
        if max_edge == 0 || max_edge > MAX_THUMBNAIL_EDGE {
            return Err(ThumbnailError::InvalidSpec(format!(
                "thumbnail max_edge must be between 1 and {MAX_THUMBNAIL_EDGE}"
            )));
        }
        Ok(Self { max_edge })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ThumbnailInfo {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Default)]
pub struct ThumbnailCancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl ThumbnailCancellationToken {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn check(&self) -> Result<(), ThumbnailError> {
        if self.is_cancelled() {
            Err(ThumbnailError::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[derive(Debug)]
pub enum ThumbnailError {
    InvalidSpec(String),
    Unsupported(String),
    Decode(String),
    Cancelled,
    Io(std::io::Error),
}

impl std::fmt::Display for ThumbnailError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSpec(message) | Self::Unsupported(message) | Self::Decode(message) => {
                formatter.write_str(message)
            }
            Self::Cancelled => formatter.write_str("thumbnail request was cancelled"),
            Self::Io(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for ThumbnailError {}

impl From<std::io::Error> for ThumbnailError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ImageThumbnailer;

#[derive(Clone, Copy)]
enum ThumbnailEncoding {
    Png,
    Jpeg,
}

impl ImageThumbnailer {
    pub fn ensure_png(
        &self,
        source: &Path,
        destination: &Path,
        spec: ThumbnailSpec,
    ) -> Result<ThumbnailInfo, ThumbnailError> {
        self.ensure_png_cancellable(
            source,
            destination,
            spec,
            &ThumbnailCancellationToken::default(),
        )
    }

    pub fn ensure_jpeg(
        &self,
        source: &Path,
        destination: &Path,
        spec: ThumbnailSpec,
    ) -> Result<ThumbnailInfo, ThumbnailError> {
        self.ensure_jpeg_cancellable(
            source,
            destination,
            spec,
            &ThumbnailCancellationToken::default(),
        )
    }

    /// Generate or reuse a PNG thumbnail while observing cancellation between
    /// expensive pipeline stages.
    pub fn ensure_png_cancellable(
        &self,
        source: &Path,
        destination: &Path,
        spec: ThumbnailSpec,
        cancellation: &ThumbnailCancellationToken,
    ) -> Result<ThumbnailInfo, ThumbnailError> {
        self.ensure_encoded_cancellable(
            source,
            destination,
            spec,
            cancellation,
            ThumbnailEncoding::Png,
        )
    }

    /// JPEG is the preferred cache representation for JPEG source photos. It
    /// avoids the expensive lossless PNG encode and substantially reduces cache
    /// bytes while keeping more than enough quality for Flow thumbnails.
    pub fn ensure_jpeg_cancellable(
        &self,
        source: &Path,
        destination: &Path,
        spec: ThumbnailSpec,
        cancellation: &ThumbnailCancellationToken,
    ) -> Result<ThumbnailInfo, ThumbnailError> {
        self.ensure_encoded_cancellable(
            source,
            destination,
            spec,
            cancellation,
            ThumbnailEncoding::Jpeg,
        )
    }

    fn ensure_encoded_cancellable(
        &self,
        source: &Path,
        destination: &Path,
        spec: ThumbnailSpec,
        cancellation: &ThumbnailCancellationToken,
        encoding: ThumbnailEncoding,
    ) -> Result<ThumbnailInfo, ThumbnailError> {
        cancellation.check()?;
        if destination.exists() {
            return dimensions_of(destination);
        }

        let parent = destination.parent().ok_or_else(|| {
            ThumbnailError::InvalidSpec("thumbnail destination must have a parent".to_owned())
        })?;
        fs::create_dir_all(parent)?;
        cancellation.check()?;

        let mut reader = ImageReader::open(source)
            .map_err(ThumbnailError::Io)?
            .with_guessed_format()
            .map_err(ThumbnailError::Io)?;

        let Some(format) = reader.format() else {
            return Err(ThumbnailError::Unsupported(
                "could not determine image format".to_owned(),
            ));
        };
        if !supported_input_format(format) {
            return Err(ThumbnailError::Unsupported(format!(
                "thumbnail decoding is not enabled for {format:?}"
            )));
        }

        let mut limits = Limits::default();
        limits.max_image_width = Some(MAX_INPUT_DIMENSION);
        limits.max_image_height = Some(MAX_INPUT_DIMENSION);
        limits.max_alloc = Some(MAX_DECODE_ALLOCATION);
        reader.limits(limits);
        cancellation.check()?;

        let decoded = reader
            .decode()
            .map_err(|error| ThumbnailError::Decode(error.to_string()))?;
        cancellation.check()?;

        let thumbnail = decoded.thumbnail(spec.max_edge, spec.max_edge);
        cancellation.check()?;
        let info = ThumbnailInfo {
            width: thumbnail.width(),
            height: thumbnail.height(),
        };

        let mut encoded = Cursor::new(Vec::new());
        match encoding {
            ThumbnailEncoding::Png => thumbnail
                .write_to(&mut encoded, ImageFormat::Png)
                .map_err(|error| ThumbnailError::Decode(error.to_string()))?,
            ThumbnailEncoding::Jpeg => JpegEncoder::new_with_quality(
                &mut encoded,
                JPEG_THUMBNAIL_QUALITY,
            )
            .encode_image(&thumbnail)
            .map_err(|error| ThumbnailError::Decode(error.to_string()))?,
        }
        cancellation.check()?;

        write_atomically(destination, encoded.into_inner())?;
        Ok(info)
    }
}

fn dimensions_of(path: &Path) -> Result<ThumbnailInfo, ThumbnailError> {
    let (width, height) =
        image::image_dimensions(path).map_err(|error| ThumbnailError::Decode(error.to_string()))?;
    Ok(ThumbnailInfo { width, height })
}

fn supported_input_format(format: ImageFormat) -> bool {
    matches!(
        format,
        ImageFormat::Jpeg
            | ImageFormat::Png
            | ImageFormat::Gif
            | ImageFormat::WebP
            | ImageFormat::Bmp
            | ImageFormat::Tiff
    )
}

fn write_atomically(destination: &Path, bytes: Vec<u8>) -> Result<(), ThumbnailError> {
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = temporary_path(destination, sequence);
    fs::write(&temp, bytes)?;

    match fs::rename(&temp, destination) {
        Ok(()) => Ok(()),
        Err(_error) if destination.exists() => {
            let _ = fs::remove_file(&temp);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&temp);
            Err(ThumbnailError::Io(error))
        }
    }
}

fn temporary_path(destination: &Path, sequence: u64) -> PathBuf {
    let mut file_name = destination
        .file_name()
        .map(|value| value.to_os_string())
        .unwrap_or_else(|| "thumbnail".into());
    file_name.push(format!(".tmp-{}-{sequence}", std::process::id()));
    destination.with_file_name(file_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb, Rgba};
    use tempfile::tempdir;

    #[test]
    fn generates_aspect_preserving_png_thumbnail() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.png");
        let destination = dir.path().join("cache/thumb.png");
        let image = ImageBuffer::from_pixel(400, 200, Rgba([20_u8, 40, 60, 255]));
        image.save(&source).unwrap();

        let info = ImageThumbnailer
            .ensure_png(&source, &destination, ThumbnailSpec::new(100).unwrap())
            .unwrap();

        assert_eq!(
            info,
            ThumbnailInfo {
                width: 100,
                height: 50
            }
        );
        assert_eq!(image::image_dimensions(&destination).unwrap(), (100, 50));
    }

    #[test]
    fn generates_aspect_preserving_jpeg_thumbnail() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.jpg");
        let destination = dir.path().join("cache/thumb.jpg");
        let image = ImageBuffer::from_pixel(400, 200, Rgb([20_u8, 40, 60]));
        image.save(&source).unwrap();

        let info = ImageThumbnailer
            .ensure_jpeg(&source, &destination, ThumbnailSpec::new(100).unwrap())
            .unwrap();

        assert_eq!(
            info,
            ThumbnailInfo {
                width: 100,
                height: 50
            }
        );
        assert_eq!(image::image_dimensions(&destination).unwrap(), (100, 50));
    }

    #[test]
    fn reuses_existing_thumbnail_without_decoding_source_again() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.png");
        let destination = dir.path().join("thumb.png");
        ImageBuffer::from_pixel(80, 40, Rgba([1_u8, 2, 3, 255]))
            .save(&source)
            .unwrap();

        let thumbnailer = ImageThumbnailer;
        thumbnailer
            .ensure_png(&source, &destination, ThumbnailSpec::new(32).unwrap())
            .unwrap();
        fs::remove_file(source).unwrap();

        assert_eq!(
            thumbnailer
                .ensure_png(
                    Path::new("missing-source.png"),
                    &destination,
                    ThumbnailSpec::new(32).unwrap()
                )
                .unwrap(),
            ThumbnailInfo {
                width: 32,
                height: 16
            }
        );
    }

    #[test]
    fn cancellation_prevents_reuse_or_generation() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.png");
        let destination = dir.path().join("thumb.png");
        ImageBuffer::from_pixel(80, 40, Rgba([1_u8, 2, 3, 255]))
            .save(&source)
            .unwrap();
        ImageBuffer::from_pixel(32, 16, Rgba([4_u8, 5, 6, 255]))
            .save(&destination)
            .unwrap();
        let cancellation = ThumbnailCancellationToken::default();
        cancellation.cancel();

        assert!(matches!(
            ImageThumbnailer.ensure_png_cancellable(
                &source,
                &destination,
                ThumbnailSpec::new(32).unwrap(),
                &cancellation,
            ),
            Err(ThumbnailError::Cancelled)
        ));
    }

    #[test]
    fn rejects_out_of_range_thumbnail_sizes() {
        assert!(matches!(
            ThumbnailSpec::new(0),
            Err(ThumbnailError::InvalidSpec(_))
        ));
        assert!(matches!(
            ThumbnailSpec::new(MAX_THUMBNAIL_EDGE + 1),
            Err(ThumbnailError::InvalidSpec(_))
        ));
    }
}
