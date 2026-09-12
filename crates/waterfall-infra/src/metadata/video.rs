use std::io::{self, Read, Seek, SeekFrom};

use waterfall_core::VisualMetadata;

const WEBM_HEADER_READ_LIMIT: u64 = 512 * 1024;
const MAX_ISO_BOXES: usize = 100_000;

const EBML_HEADER_ID: u64 = 0x1a45_dfa3;
const SEGMENT_ID: u64 = 0x1853_8067;
const TRACKS_ID: u64 = 0x1654_ae6b;
const TRACK_ENTRY_ID: u64 = 0xae;
const TRACK_TYPE_ID: u64 = 0x83;
const VIDEO_ID: u64 = 0xe0;
const PIXEL_WIDTH_ID: u64 = 0xb0;
const PIXEL_HEIGHT_ID: u64 = 0xba;

pub(super) fn read_video_dimensions<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
) -> io::Result<Option<VisualMetadata>> {
    if file_len < 8 {
        return Ok(None);
    }

    if let Some(dimensions) = parse_iso_bmff(reader, file_len)? {
        return Ok(Some(dimensions));
    }

    reader.seek(SeekFrom::Start(0))?;
    let mut header = Vec::with_capacity(file_len.min(WEBM_HEADER_READ_LIMIT) as usize);
    reader
        .take(WEBM_HEADER_READ_LIMIT)
        .read_to_end(&mut header)?;

    Ok(parse_ebml_video_dimensions(&header))
}

#[derive(Clone, Copy, Debug)]
struct IsoBox {
    kind: [u8; 4],
    payload_start: u64,
    end: u64,
}

fn parse_iso_bmff<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
) -> io::Result<Option<VisualMetadata>> {
    let mut cursor = 0u64;
    let mut visited = 0usize;

    while cursor.saturating_add(8) <= file_len && visited < MAX_ISO_BOXES {
        let Some(current) = read_iso_box(reader, cursor, file_len)? else {
            return Ok(None);
        };
        visited += 1;

        if &current.kind == b"moov" {
            return parse_moov(reader, current);
        }

        cursor = current.end;
    }

    Ok(None)
}

fn parse_moov<R: Read + Seek>(reader: &mut R, moov: IsoBox) -> io::Result<Option<VisualMetadata>> {
    let mut cursor = moov.payload_start;
    let mut visited = 0usize;

    while cursor.saturating_add(8) <= moov.end && visited < MAX_ISO_BOXES {
        let Some(current) = read_iso_box(reader, cursor, moov.end)? else {
            return Ok(None);
        };
        visited += 1;

        if &current.kind == b"trak" {
            if let Some(dimensions) = parse_trak(reader, current)? {
                return Ok(Some(dimensions));
            }
        }

        cursor = current.end;
    }

    Ok(None)
}

fn parse_trak<R: Read + Seek>(reader: &mut R, trak: IsoBox) -> io::Result<Option<VisualMetadata>> {
    let mut cursor = trak.payload_start;
    let mut visited = 0usize;
    let mut dimensions = None;
    let mut is_video = false;

    while cursor.saturating_add(8) <= trak.end && visited < MAX_ISO_BOXES {
        let Some(current) = read_iso_box(reader, cursor, trak.end)? else {
            return Ok(None);
        };
        visited += 1;

        match &current.kind {
            b"tkhd" => dimensions = read_tkhd_dimensions(reader, current)?,
            b"mdia" => is_video = parse_mdia_is_video(reader, current)?,
            _ => {}
        }

        if is_video {
            if let Some(dimensions) = dimensions {
                return Ok(Some(dimensions));
            }
        }

        cursor = current.end;
    }

    Ok(is_video.then_some(dimensions).flatten())
}

fn parse_mdia_is_video<R: Read + Seek>(reader: &mut R, mdia: IsoBox) -> io::Result<bool> {
    let mut cursor = mdia.payload_start;
    let mut visited = 0usize;

    while cursor.saturating_add(8) <= mdia.end && visited < MAX_ISO_BOXES {
        let Some(current) = read_iso_box(reader, cursor, mdia.end)? else {
            return Ok(false);
        };
        visited += 1;

        if &current.kind == b"hdlr" {
            return read_hdlr_is_video(reader, current);
        }

        cursor = current.end;
    }

    Ok(false)
}

fn read_hdlr_is_video<R: Read + Seek>(reader: &mut R, hdlr: IsoBox) -> io::Result<bool> {
    let handler_offset = hdlr.payload_start.saturating_add(8);
    if handler_offset.saturating_add(4) > hdlr.end {
        return Ok(false);
    }

    reader.seek(SeekFrom::Start(handler_offset))?;
    let mut handler = [0u8; 4];
    reader.read_exact(&mut handler)?;
    Ok(&handler == b"vide")
}

fn read_tkhd_dimensions<R: Read + Seek>(
    reader: &mut R,
    tkhd: IsoBox,
) -> io::Result<Option<VisualMetadata>> {
    const MATRIX_AND_DIMENSIONS_BYTES: u64 = 44;
    if tkhd.end.saturating_sub(tkhd.payload_start) < MATRIX_AND_DIMENSIONS_BYTES {
        return Ok(None);
    }

    reader.seek(SeekFrom::Start(
        tkhd.end.saturating_sub(MATRIX_AND_DIMENSIONS_BYTES),
    ))?;
    let mut tail = [0u8; MATRIX_AND_DIMENSIONS_BYTES as usize];
    reader.read_exact(&mut tail)?;

    let width = fixed_16_16_to_pixels(be_u32(&tail, 36));
    let height = fixed_16_16_to_pixels(be_u32(&tail, 40));
    let (Some(mut width), Some(mut height)) = (width, height) else {
        return Ok(None);
    };

    let a = be_i32(&tail, 0);
    let b = be_i32(&tail, 4);
    let c = be_i32(&tail, 12);
    let d = be_i32(&tail, 16);
    if is_quarter_turn_matrix(a, b, c, d) {
        std::mem::swap(&mut width, &mut height);
    }

    Ok(dimensions(width, height))
}

fn read_iso_box<R: Read + Seek>(
    reader: &mut R,
    start: u64,
    parent_end: u64,
) -> io::Result<Option<IsoBox>> {
    if start.saturating_add(8) > parent_end {
        return Ok(None);
    }

    reader.seek(SeekFrom::Start(start))?;
    let mut header = [0u8; 8];
    reader.read_exact(&mut header)?;

    let size32 = u32::from_be_bytes(header[..4].try_into().expect("four-byte size"));
    let kind: [u8; 4] = header[4..8].try_into().expect("four-byte box kind");
    let mut header_len = 8u64;

    let size = match size32 {
        0 => parent_end.saturating_sub(start),
        1 => {
            if start.saturating_add(16) > parent_end {
                return Ok(None);
            }
            let mut extended = [0u8; 8];
            reader.read_exact(&mut extended)?;
            header_len = 16;
            u64::from_be_bytes(extended)
        }
        value => u64::from(value),
    };

    if &kind == b"uuid" {
        header_len = header_len.saturating_add(16);
    }

    if size < header_len {
        return Ok(None);
    }

    let Some(end) = start.checked_add(size) else {
        return Ok(None);
    };
    if end > parent_end {
        return Ok(None);
    }

    let Some(payload_start) = start.checked_add(header_len) else {
        return Ok(None);
    };
    if payload_start > end {
        return Ok(None);
    }

    Ok(Some(IsoBox {
        kind,
        payload_start,
        end,
    }))
}

fn fixed_16_16_to_pixels(value: u32) -> Option<u32> {
    let rounded = (u64::from(value) + 0x8000) >> 16;
    let rounded = u32::try_from(rounded).ok()?;
    (rounded > 0).then_some(rounded)
}

fn is_quarter_turn_matrix(a: i32, b: i32, c: i32, d: i32) -> bool {
    const ONE: i64 = 1 << 16;
    a == 0 && d == 0 && i64::from(b).abs() == ONE && i64::from(c).abs() == ONE
}

fn be_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(
        data[offset..offset + 4]
            .try_into()
            .expect("validated fixed-size field"),
    )
}

fn be_i32(data: &[u8], offset: usize) -> i32 {
    i32::from_be_bytes(
        data[offset..offset + 4]
            .try_into()
            .expect("validated fixed-size field"),
    )
}

#[derive(Clone, Copy, Debug)]
struct EbmlElement {
    id: u64,
    payload_start: usize,
    payload_end: usize,
    complete: bool,
    unknown_size: bool,
}

fn parse_ebml_video_dimensions(data: &[u8]) -> Option<VisualMetadata> {
    let header = read_ebml_element(data, 0, data.len())?;
    if header.id != EBML_HEADER_ID || !header.complete {
        return None;
    }

    let mut cursor = header.payload_end;
    while cursor < data.len() {
        let element = read_ebml_element(data, cursor, data.len())?;
        if element.id == SEGMENT_ID {
            return parse_segment(data, element);
        }
        if element.payload_end <= cursor || element.unknown_size {
            break;
        }
        cursor = element.payload_end;
    }

    None
}

fn parse_segment(data: &[u8], segment: EbmlElement) -> Option<VisualMetadata> {
    let mut cursor = segment.payload_start;
    while cursor < segment.payload_end {
        let element = read_ebml_element(data, cursor, segment.payload_end)?;
        if element.id == TRACKS_ID {
            if let Some(dimensions) = parse_tracks(data, element) {
                return Some(dimensions);
            }
        }
        if element.payload_end <= cursor || element.unknown_size {
            break;
        }
        cursor = element.payload_end;
    }
    None
}

fn parse_tracks(data: &[u8], tracks: EbmlElement) -> Option<VisualMetadata> {
    let mut cursor = tracks.payload_start;
    while cursor < tracks.payload_end {
        let element = read_ebml_element(data, cursor, tracks.payload_end)?;
        if element.id == TRACK_ENTRY_ID {
            if let Some(dimensions) = parse_track_entry(data, element) {
                return Some(dimensions);
            }
        }
        if element.payload_end <= cursor || element.unknown_size {
            break;
        }
        cursor = element.payload_end;
    }
    None
}

fn parse_track_entry(data: &[u8], entry: EbmlElement) -> Option<VisualMetadata> {
    let mut cursor = entry.payload_start;
    let mut track_type = None;
    let mut video_dimensions = None;

    while cursor < entry.payload_end {
        let element = read_ebml_element(data, cursor, entry.payload_end)?;
        match element.id {
            TRACK_TYPE_ID => track_type = read_ebml_uint(data, element),
            VIDEO_ID => video_dimensions = parse_video_element(data, element),
            _ => {}
        }

        if track_type == Some(1) && video_dimensions.is_some() {
            return video_dimensions;
        }
        if element.payload_end <= cursor || element.unknown_size {
            break;
        }
        cursor = element.payload_end;
    }

    (track_type == Some(1))
        .then_some(video_dimensions)
        .flatten()
}

fn parse_video_element(data: &[u8], video: EbmlElement) -> Option<VisualMetadata> {
    let mut cursor = video.payload_start;
    let mut width = None;
    let mut height = None;

    while cursor < video.payload_end {
        let element = read_ebml_element(data, cursor, video.payload_end)?;
        match element.id {
            PIXEL_WIDTH_ID => width = read_ebml_uint(data, element).and_then(u32_from_u64),
            PIXEL_HEIGHT_ID => height = read_ebml_uint(data, element).and_then(u32_from_u64),
            _ => {}
        }

        if let (Some(width), Some(height)) = (width, height) {
            return dimensions(width, height);
        }
        if element.payload_end <= cursor || element.unknown_size {
            break;
        }
        cursor = element.payload_end;
    }

    None
}

fn read_ebml_element(data: &[u8], cursor: usize, parent_end: usize) -> Option<EbmlElement> {
    if cursor >= parent_end || parent_end > data.len() {
        return None;
    }

    let (id, id_len) = read_ebml_id(data, cursor, parent_end)?;
    let size_offset = cursor.checked_add(id_len)?;
    let (size, size_len) = read_ebml_size(data, size_offset, parent_end)?;
    let payload_start = size_offset.checked_add(size_len)?;
    if payload_start > parent_end {
        return None;
    }

    let (payload_end, complete, unknown_size) = match size {
        Some(size) => {
            let declared_end = payload_start.checked_add(size)?;
            (
                declared_end.min(parent_end),
                declared_end <= parent_end,
                false,
            )
        }
        None => (parent_end, false, true),
    };

    Some(EbmlElement {
        id,
        payload_start,
        payload_end,
        complete,
        unknown_size,
    })
}

fn read_ebml_id(data: &[u8], cursor: usize, parent_end: usize) -> Option<(u64, usize)> {
    let first = *data.get(cursor)?;
    let len = vint_len(first, 4)?;
    let end = cursor.checked_add(len)?;
    if end > parent_end {
        return None;
    }

    let mut value = 0u64;
    for byte in &data[cursor..end] {
        value = (value << 8) | u64::from(*byte);
    }
    Some((value, len))
}

fn read_ebml_size(data: &[u8], cursor: usize, parent_end: usize) -> Option<(Option<usize>, usize)> {
    let first = *data.get(cursor)?;
    let len = vint_len(first, 8)?;
    let end = cursor.checked_add(len)?;
    if end > parent_end {
        return None;
    }

    let marker_mask = 1u8 << (8 - len);
    let mut value = u64::from(first & !marker_mask);
    for byte in &data[cursor + 1..end] {
        value = (value << 8) | u64::from(*byte);
    }

    let value_bits = 7usize.checked_mul(len)?;
    let unknown_value = (1u64 << value_bits) - 1;
    if value == unknown_value {
        return Some((None, len));
    }

    Some((Some(usize::try_from(value).ok()?), len))
}

fn vint_len(first: u8, max_len: usize) -> Option<usize> {
    if first == 0 {
        return None;
    }
    let len = first.leading_zeros() as usize + 1;
    (len <= max_len).then_some(len)
}

fn read_ebml_uint(data: &[u8], element: EbmlElement) -> Option<u64> {
    if !element.complete {
        return None;
    }
    let len = element.payload_end.checked_sub(element.payload_start)?;
    if !(1..=8).contains(&len) {
        return None;
    }

    let mut value = 0u64;
    for byte in &data[element.payload_start..element.payload_end] {
        value = (value << 8) | u64::from(*byte);
    }
    Some(value)
}

fn u32_from_u64(value: u64) -> Option<u32> {
    u32::try_from(value).ok()
}

fn dimensions(width: u32, height: u32) -> Option<VisualMetadata> {
    if width == 0 || height == 0 {
        None
    } else {
        Some(VisualMetadata { width, height })
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn parses_mp4_video_track_with_moov_after_media_data() {
        let tkhd = iso_box(*b"tkhd", tkhd_payload(1920, 1080, false));
        let hdlr = iso_box(*b"hdlr", hdlr_payload(*b"vide"));
        let mdia = iso_box(*b"mdia", hdlr);
        let trak = iso_box(*b"trak", [tkhd, mdia].concat());
        let moov = iso_box(*b"moov", trak);
        let ftyp = iso_box(*b"ftyp", b"isom\0\0\0\0".to_vec());
        let mdat = iso_box(*b"mdat", vec![0x55; 4096]);
        let bytes = [ftyp, mdat, moov].concat();

        let mut cursor = Cursor::new(bytes.clone());
        assert_eq!(
            read_video_dimensions(&mut cursor, bytes.len() as u64).unwrap(),
            Some(VisualMetadata {
                width: 1920,
                height: 1080,
            })
        );
    }

    #[test]
    fn applies_quarter_turn_track_matrix_to_mp4_dimensions() {
        let tkhd = iso_box(*b"tkhd", tkhd_payload(1920, 1080, true));
        let hdlr = iso_box(*b"hdlr", hdlr_payload(*b"vide"));
        let mdia = iso_box(*b"mdia", hdlr);
        let trak = iso_box(*b"trak", [tkhd, mdia].concat());
        let moov = iso_box(*b"moov", trak);
        let bytes = moov;

        let mut cursor = Cursor::new(bytes.clone());
        assert_eq!(
            read_video_dimensions(&mut cursor, bytes.len() as u64).unwrap(),
            Some(VisualMetadata {
                width: 1080,
                height: 1920,
            })
        );
    }

    #[test]
    fn ignores_non_video_mp4_tracks() {
        let tkhd = iso_box(*b"tkhd", tkhd_payload(640, 480, false));
        let hdlr = iso_box(*b"hdlr", hdlr_payload(*b"soun"));
        let mdia = iso_box(*b"mdia", hdlr);
        let trak = iso_box(*b"trak", [tkhd, mdia].concat());
        let moov = iso_box(*b"moov", trak);

        let mut cursor = Cursor::new(moov.clone());
        assert_eq!(
            read_video_dimensions(&mut cursor, moov.len() as u64).unwrap(),
            None
        );
    }

    #[test]
    fn parses_webm_video_track_dimensions() {
        let width = ebml_element(&[0xb0], &1920u16.to_be_bytes());
        let height = ebml_element(&[0xba], &1080u16.to_be_bytes());
        let video = ebml_element(&[0xe0], &[width, height].concat());
        let track_type = ebml_element(&[0x83], &[1]);
        let track_entry = ebml_element(&[0xae], &[track_type, video].concat());
        let tracks = ebml_element(&[0x16, 0x54, 0xae, 0x6b], &track_entry);
        let mut segment = vec![0x18, 0x53, 0x80, 0x67, 0xff];
        segment.extend_from_slice(&tracks);
        let ebml_header = ebml_element(&[0x1a, 0x45, 0xdf, 0xa3], &[]);
        let bytes = [ebml_header, segment].concat();

        let mut cursor = Cursor::new(bytes.clone());
        assert_eq!(
            read_video_dimensions(&mut cursor, bytes.len() as u64).unwrap(),
            Some(VisualMetadata {
                width: 1920,
                height: 1080,
            })
        );
    }

    #[test]
    fn rejects_truncated_or_unknown_video_containers() {
        for bytes in [
            b"not video".to_vec(),
            vec![0, 0, 0, 20, b'm', b'o', b'o', b'v'],
            vec![0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42],
        ] {
            let mut cursor = Cursor::new(bytes.clone());
            assert_eq!(
                read_video_dimensions(&mut cursor, bytes.len() as u64).unwrap(),
                None
            );
        }
    }

    fn iso_box(kind: [u8; 4], payload: Vec<u8>) -> Vec<u8> {
        let size = 8usize.checked_add(payload.len()).unwrap();
        let mut output = Vec::with_capacity(size);
        output.extend_from_slice(&(size as u32).to_be_bytes());
        output.extend_from_slice(&kind);
        output.extend_from_slice(&payload);
        output
    }

    fn tkhd_payload(width: u32, height: u32, quarter_turn: bool) -> Vec<u8> {
        let mut payload = vec![0u8; 44];
        if quarter_turn {
            payload[4..8].copy_from_slice(&(1i32 << 16).to_be_bytes());
            payload[12..16].copy_from_slice(&(-(1i32 << 16)).to_be_bytes());
        } else {
            payload[0..4].copy_from_slice(&(1i32 << 16).to_be_bytes());
            payload[16..20].copy_from_slice(&(1i32 << 16).to_be_bytes());
        }
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

    fn ebml_element(id: &[u8], payload: &[u8]) -> Vec<u8> {
        assert!(payload.len() < 0x7f);
        let mut output = Vec::with_capacity(id.len() + 1 + payload.len());
        output.extend_from_slice(id);
        output.push(0x80 | payload.len() as u8);
        output.extend_from_slice(payload);
        output
    }
}
