use std::{fs::File, io::Read};

use waterfall_core::{MediaKind, MetadataReadFailure, VisualMetadata, VisualMetadataReader};

const FAST_HEADER_BYTES: u64 = 32;
const JPEG_HEADER_READ_LIMIT: u64 = 512 * 1024;

#[derive(Debug, Default)]
pub struct HeaderVisualMetadataReader;

impl HeaderVisualMetadataReader {
    pub fn new() -> Self {
        Self
    }
}

impl VisualMetadataReader for HeaderVisualMetadataReader {
    fn read_visual_metadata(
        &self,
        locator: &str,
        kind: &MediaKind,
    ) -> Result<Option<VisualMetadata>, MetadataReadFailure> {
        if !matches!(kind, MediaKind::Image | MediaKind::AnimatedImage) {
            return Ok(None);
        }

        let mut file = File::open(locator).map_err(|error| {
            MetadataReadFailure::new(format!("failed to open media header: {error}"))
        })?;
        let mut header = Vec::with_capacity(FAST_HEADER_BYTES as usize);
        file.by_ref()
            .take(FAST_HEADER_BYTES)
            .read_to_end(&mut header)
            .map_err(|error| {
                MetadataReadFailure::new(format!("failed to read media header: {error}"))
            })?;

        if !is_jpeg(&header) {
            return Ok(parse_dimensions(&header));
        }

        let remaining = JPEG_HEADER_READ_LIMIT.saturating_sub(header.len() as u64);
        file.take(remaining)
            .read_to_end(&mut header)
            .map_err(|error| {
                MetadataReadFailure::new(format!("failed to read JPEG header: {error}"))
            })?;

        Ok(parse_jpeg(&header))
    }
}

fn parse_dimensions(data: &[u8]) -> Option<VisualMetadata> {
    parse_png(data)
        .or_else(|| parse_gif(data))
        .or_else(|| parse_bmp(data))
        .or_else(|| parse_webp(data))
        .or_else(|| parse_jpeg(data))
}

fn parse_png(data: &[u8]) -> Option<VisualMetadata> {
    if data.get(..8)? != b"\x89PNG\r\n\x1a\n" || data.get(12..16)? != b"IHDR" {
        return None;
    }

    dimensions(be_u32(data, 16)?, be_u32(data, 20)?)
}

fn parse_gif(data: &[u8]) -> Option<VisualMetadata> {
    let signature = data.get(..6)?;
    if signature != b"GIF87a" && signature != b"GIF89a" {
        return None;
    }

    dimensions(u32::from(le_u16(data, 6)?), u32::from(le_u16(data, 8)?))
}

fn parse_bmp(data: &[u8]) -> Option<VisualMetadata> {
    if data.get(..2)? != b"BM" {
        return None;
    }

    match le_u32(data, 14)? {
        12 => dimensions(u32::from(le_u16(data, 18)?), u32::from(le_u16(data, 20)?)),
        size if size >= 40 => {
            let width = le_i32(data, 18)?;
            let height = le_i32(data, 22)?;
            if width <= 0 || height == 0 {
                return None;
            }
            dimensions(width as u32, height.unsigned_abs())
        }
        _ => None,
    }
}

fn parse_webp(data: &[u8]) -> Option<VisualMetadata> {
    if data.get(..4)? != b"RIFF" || data.get(8..12)? != b"WEBP" {
        return None;
    }

    match data.get(12..16)? {
        b"VP8X" => dimensions(
            le_u24(data, 24)?.checked_add(1)?,
            le_u24(data, 27)?.checked_add(1)?,
        ),
        b"VP8L" => {
            if *data.get(20)? != 0x2f {
                return None;
            }
            let bits = le_u32(data, 21)?;
            let width = (bits & 0x3fff) + 1;
            let height = ((bits >> 14) & 0x3fff) + 1;
            dimensions(width, height)
        }
        b"VP8 " => {
            if data.get(23..26)? != [0x9d, 0x01, 0x2a] {
                return None;
            }
            let width = u32::from(le_u16(data, 26)? & 0x3fff);
            let height = u32::from(le_u16(data, 28)? & 0x3fff);
            dimensions(width, height)
        }
        _ => None,
    }
}

fn parse_jpeg(data: &[u8]) -> Option<VisualMetadata> {
    if !is_jpeg(data) {
        return None;
    }

    let mut cursor = 2usize;
    while cursor < data.len() {
        if *data.get(cursor)? != 0xff {
            cursor += 1;
            continue;
        }

        while data.get(cursor) == Some(&0xff) {
            cursor += 1;
        }
        let marker = *data.get(cursor)?;
        cursor += 1;

        if marker == 0x00 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if marker == 0xd9 || marker == 0xda {
            return None;
        }

        let segment_length = usize::from(be_u16(data, cursor)?);
        if segment_length < 2 {
            return None;
        }

        if is_jpeg_start_of_frame(marker) {
            if segment_length < 7 {
                return None;
            }
            let height = u32::from(be_u16(data, cursor + 3)?);
            let width = u32::from(be_u16(data, cursor + 5)?);
            return dimensions(width, height);
        }

        cursor = cursor.checked_add(segment_length)?;
    }

    None
}

fn is_jpeg(data: &[u8]) -> bool {
    data.len() >= 2 && data[0] == 0xff && data[1] == 0xd8
}

fn is_jpeg_start_of_frame(marker: u8) -> bool {
    matches!(
        marker,
        0xc0 | 0xc1 | 0xc2 | 0xc3 | 0xc5 | 0xc6 | 0xc7 | 0xc9 | 0xca | 0xcb | 0xcd | 0xce | 0xcf
    )
}

fn dimensions(width: u32, height: u32) -> Option<VisualMetadata> {
    if width == 0 || height == 0 {
        None
    } else {
        Some(VisualMetadata { width, height })
    }
}

fn be_u16(data: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        data.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn le_u16(data: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        data.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn be_u32(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        data.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn le_u32(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        data.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn le_i32(data: &[u8], offset: usize) -> Option<i32> {
    Some(i32::from_le_bytes(
        data.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn le_u24(data: &[u8], offset: usize) -> Option<u32> {
    let bytes = data.get(offset..offset + 3)?;
    Some(u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_png_dimensions_without_full_image() {
        let mut data = vec![0; 24];
        data[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        data[12..16].copy_from_slice(b"IHDR");
        data[16..20].copy_from_slice(&1920u32.to_be_bytes());
        data[20..24].copy_from_slice(&1080u32.to_be_bytes());

        assert_eq!(
            parse_dimensions(&data),
            Some(VisualMetadata {
                width: 1920,
                height: 1080
            })
        );
    }

    #[test]
    fn parses_gif_dimensions() {
        let mut data = b"GIF89a\0\0\0\0".to_vec();
        data[6..8].copy_from_slice(&640u16.to_le_bytes());
        data[8..10].copy_from_slice(&480u16.to_le_bytes());

        assert_eq!(
            parse_dimensions(&data),
            Some(VisualMetadata {
                width: 640,
                height: 480
            })
        );
    }

    #[test]
    fn parses_bmp_dimensions_and_top_down_height() {
        let mut data = vec![0; 26];
        data[..2].copy_from_slice(b"BM");
        data[14..18].copy_from_slice(&40u32.to_le_bytes());
        data[18..22].copy_from_slice(&800i32.to_le_bytes());
        data[22..26].copy_from_slice(&(-600i32).to_le_bytes());

        assert_eq!(
            parse_dimensions(&data),
            Some(VisualMetadata {
                width: 800,
                height: 600
            })
        );
    }

    #[test]
    fn parses_webp_extended_dimensions() {
        let mut data = vec![0; 30];
        data[..4].copy_from_slice(b"RIFF");
        data[8..12].copy_from_slice(b"WEBP");
        data[12..16].copy_from_slice(b"VP8X");
        write_u24_le(&mut data, 24, 1279);
        write_u24_le(&mut data, 27, 719);

        assert_eq!(
            parse_dimensions(&data),
            Some(VisualMetadata {
                width: 1280,
                height: 720
            })
        );
    }

    #[test]
    fn parses_jpeg_sof_dimensions() {
        let data = [
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04,
            0x38, 0x07, 0x80,
        ];

        assert_eq!(
            parse_dimensions(&data),
            Some(VisualMetadata {
                width: 1920,
                height: 1080
            })
        );
    }

    #[test]
    fn rejects_truncated_or_unknown_headers() {
        assert_eq!(parse_dimensions(b"not an image"), None);
        assert_eq!(parse_dimensions(b"\x89PNG"), None);
        assert_eq!(parse_dimensions(&[0xff, 0xd8, 0xff]), None);
    }

    fn write_u24_le(data: &mut [u8], offset: usize, value: u32) {
        data[offset] = value as u8;
        data[offset + 1] = (value >> 8) as u8;
        data[offset + 2] = (value >> 16) as u8;
    }
}
