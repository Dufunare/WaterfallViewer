use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
};

use waterfall_core::{AudioDetail, MetadataReadFailure};

const MAX_HEADER_PAGES: usize = 64;
const MAX_PACKET_BYTES: usize = 2 * 1024 * 1024;
const OGG_MAX_PAGE_BYTES: usize = 27 + 255 + 255 * 255;
const TAIL_WINDOW_BYTES: usize = OGG_MAX_PAGE_BYTES * 2;

pub(super) fn read_ogg_detail_file(
    locator: &str,
) -> Result<Option<AudioDetail>, MetadataReadFailure> {
    let mut file = File::open(locator).map_err(|error| {
        MetadataReadFailure::new(format!("failed to open audio detail: {error}"))
    })?;
    let file_len = file
        .metadata()
        .map_err(|error| {
            MetadataReadFailure::new(format!("failed to inspect audio detail: {error}"))
        })?
        .len();
    read_ogg_detail(&mut file, file_len)
        .map_err(|error| MetadataReadFailure::new(format!("failed to read Ogg detail: {error}")))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OggCodec {
    Vorbis { sample_rate: u32 },
    Opus { pre_skip: u16 },
}

#[derive(Debug)]
struct OggPage {
    header_type: u8,
    granule_position: u64,
    serial: u32,
    lacing: Vec<u8>,
    payload: Vec<u8>,
}

fn read_ogg_detail<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
) -> io::Result<Option<AudioDetail>> {
    if file_len < 27 {
        return Ok(None);
    }

    reader.seek(SeekFrom::Start(0))?;
    let mut selected_serial = None;
    let mut codec = None;
    let mut packet = Vec::new();
    let mut title = None;
    let mut artist = None;
    let mut saw_comments = false;

    for _ in 0..MAX_HEADER_PAGES {
        let Some(page) = read_page(reader)? else {
            break;
        };

        if selected_serial.is_none() {
            if page.header_type & 0x02 == 0 {
                continue;
            }
            if let Some(found) = identify_codec_from_page(&page) {
                selected_serial = Some(page.serial);
                codec = Some(found);
            } else {
                continue;
            }
        }

        if Some(page.serial) != selected_serial {
            continue;
        }

        for (index, segment_len) in page.lacing.iter().copied().enumerate() {
            let segment_start = page.lacing[..index]
                .iter()
                .map(|value| usize::from(*value))
                .sum::<usize>();
            let segment_end = segment_start + usize::from(segment_len);
            let Some(segment) = page.payload.get(segment_start..segment_end) else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Ogg segment exceeds page payload",
                ));
            };
            if packet.len().saturating_add(segment.len()) > MAX_PACKET_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Ogg header packet exceeds configured limit",
                ));
            }
            packet.extend_from_slice(segment);

            if segment_len < 255 {
                if let Some(current_codec) = codec {
                    if parse_comment_packet(current_codec, &packet, &mut title, &mut artist) {
                        saw_comments = true;
                    }
                }
                packet.clear();
            }
        }

        if saw_comments {
            break;
        }
    }

    let (serial, codec) = match (selected_serial, codec) {
        (Some(serial), Some(codec)) => (serial, codec),
        _ => return Ok(None),
    };

    let final_granule = read_final_granule(reader, file_len, serial)?;
    let duration_ms = final_granule.and_then(|granule| duration_from_granule(codec, granule));
    let codec_name = match codec {
        OggCodec::Vorbis { .. } => "vorbis",
        OggCodec::Opus { .. } => "opus",
    };

    Ok(Some(AudioDetail {
        duration_ms,
        title,
        artist,
        codec: Some(codec_name.to_string()),
    }))
}

fn identify_codec_from_page(page: &OggPage) -> Option<OggCodec> {
    let first_packet = first_complete_packet(page)?;
    if first_packet.starts_with(b"OpusHead") && first_packet.len() >= 12 {
        return Some(OggCodec::Opus {
            pre_skip: u16::from_le_bytes(first_packet[10..12].try_into().ok()?),
        });
    }
    if first_packet.starts_with(b"\x01vorbis") && first_packet.len() >= 16 {
        let sample_rate = u32::from_le_bytes(first_packet[12..16].try_into().ok()?);
        if sample_rate > 0 {
            return Some(OggCodec::Vorbis { sample_rate });
        }
    }
    None
}

fn first_complete_packet(page: &OggPage) -> Option<&[u8]> {
    let mut len = 0usize;
    for segment_len in page.lacing.iter().copied() {
        len = len.checked_add(usize::from(segment_len))?;
        if segment_len < 255 {
            return page.payload.get(..len);
        }
    }
    None
}

fn parse_comment_packet(
    codec: OggCodec,
    packet: &[u8],
    title: &mut Option<String>,
    artist: &mut Option<String>,
) -> bool {
    let body = match codec {
        OggCodec::Opus { .. } if packet.starts_with(b"OpusTags") => &packet[8..],
        OggCodec::Vorbis { .. } if packet.starts_with(b"\x03vorbis") => &packet[7..],
        _ => return false,
    };
    read_vorbis_comments(body, title, artist);
    true
}

fn read_vorbis_comments(data: &[u8], title: &mut Option<String>, artist: &mut Option<String>) {
    let mut cursor = 0usize;
    let Some(vendor_len) = read_le_u32(data, &mut cursor) else {
        return;
    };
    if !skip_bytes(data, &mut cursor, vendor_len as usize) {
        return;
    }
    let Some(comment_count) = read_le_u32(data, &mut cursor) else {
        return;
    };

    for _ in 0..comment_count.min(10_000) {
        let Some(comment_len) = read_le_u32(data, &mut cursor) else {
            return;
        };
        let Some(comment) = take_bytes(data, &mut cursor, comment_len as usize) else {
            return;
        };
        let Ok(comment) = std::str::from_utf8(comment) else {
            continue;
        };
        let Some((key, value)) = comment.split_once('=') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if title.is_none() && key.eq_ignore_ascii_case("TITLE") {
            *title = Some(value.to_string());
        } else if artist.is_none() && key.eq_ignore_ascii_case("ARTIST") {
            *artist = Some(value.to_string());
        }
    }
}

fn duration_from_granule(codec: OggCodec, granule: u64) -> Option<u64> {
    if granule == u64::MAX {
        return None;
    }
    match codec {
        OggCodec::Vorbis { sample_rate } if sample_rate > 0 => granule
            .checked_mul(1000)
            .map(|samples| samples / u64::from(sample_rate)),
        OggCodec::Opus { pre_skip } => granule
            .checked_sub(u64::from(pre_skip))?
            .checked_mul(1000)
            .map(|samples| samples / 48_000),
        _ => None,
    }
}

fn read_final_granule<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
    serial: u32,
) -> io::Result<Option<u64>> {
    let window_len = file_len.min(TAIL_WINDOW_BYTES as u64) as usize;
    reader.seek(SeekFrom::End(-(window_len as i64)))?;
    let mut tail = vec![0u8; window_len];
    reader.read_exact(&mut tail)?;

    let mut cursor = 0usize;
    let mut last = None;
    while cursor.saturating_add(27) <= tail.len() {
        let Some(relative) = tail[cursor..]
            .windows(4)
            .position(|bytes| bytes == b"OggS")
        else {
            break;
        };
        let start = cursor + relative;
        let Some((page_len, page_serial, granule)) = inspect_page_in_slice(&tail[start..]) else {
            cursor = start + 1;
            continue;
        };
        if page_serial == serial && granule != u64::MAX {
            last = Some(granule);
        }
        cursor = start.saturating_add(page_len.max(1));
    }
    Ok(last)
}

fn inspect_page_in_slice(data: &[u8]) -> Option<(usize, u32, u64)> {
    if data.len() < 27 || &data[..4] != b"OggS" || data[4] != 0 {
        return None;
    }
    let segment_count = usize::from(data[26]);
    let header_len = 27usize.checked_add(segment_count)?;
    let lacing = data.get(27..header_len)?;
    let payload_len = lacing
        .iter()
        .try_fold(0usize, |acc, value| acc.checked_add(usize::from(*value)))?;
    let page_len = header_len.checked_add(payload_len)?;
    if page_len > data.len() {
        return None;
    }
    let granule = u64::from_le_bytes(data[6..14].try_into().ok()?);
    let serial = u32::from_le_bytes(data[14..18].try_into().ok()?);
    Some((page_len, serial, granule))
}

fn read_page<R: Read>(reader: &mut R) -> io::Result<Option<OggPage>> {
    let mut header = [0u8; 27];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    if &header[..4] != b"OggS" || header[4] != 0 {
        return Ok(None);
    }

    let segment_count = usize::from(header[26]);
    let mut lacing = vec![0u8; segment_count];
    reader.read_exact(&mut lacing)?;
    let payload_len = lacing
        .iter()
        .try_fold(0usize, |acc, value| acc.checked_add(usize::from(*value)))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Ogg page is too large"))?;
    let mut payload = vec![0u8; payload_len];
    reader.read_exact(&mut payload)?;

    Ok(Some(OggPage {
        header_type: header[5],
        granule_position: u64::from_le_bytes(header[6..14].try_into().expect("granule position")),
        serial: u32::from_le_bytes(header[14..18].try_into().expect("stream serial")),
        lacing,
        payload,
    }))
}

fn read_le_u32(data: &[u8], cursor: &mut usize) -> Option<u32> {
    let bytes = take_bytes(data, cursor, 4)?;
    Some(u32::from_le_bytes(bytes.try_into().ok()?))
}

fn skip_bytes(data: &[u8], cursor: &mut usize, len: usize) -> bool {
    take_bytes(data, cursor, len).is_some()
}

fn take_bytes<'a>(data: &'a [u8], cursor: &mut usize, len: usize) -> Option<&'a [u8]> {
    let end = cursor.checked_add(len)?;
    let bytes = data.get(*cursor..end)?;
    *cursor = end;
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::{duration_from_granule, read_ogg_detail, OggCodec};

    #[test]
    fn reads_vorbis_duration_and_comments() {
        let serial = 7;
        let identification = vorbis_identification(48_000);
        let comments = vorbis_comments(b"\x03vorbis", &["TITLE=Waterfall", "artist=Viewer"]);
        let setup = b"\x05vorbissetup".to_vec();
        let mut bytes = Vec::new();
        bytes.extend(page(serial, 0, 0x02, &[identification]));
        bytes.extend(page(serial, 0, 0, &[comments, setup]));
        bytes.extend(page(serial, 96_000, 0x04, &[b"audio".to_vec()]));
        let len = bytes.len() as u64;

        let detail = read_ogg_detail(&mut Cursor::new(bytes), len)
            .unwrap()
            .expect("Vorbis detail");
        assert_eq!(detail.codec.as_deref(), Some("vorbis"));
        assert_eq!(detail.duration_ms, Some(2_000));
        assert_eq!(detail.title.as_deref(), Some("Waterfall"));
        assert_eq!(detail.artist.as_deref(), Some("Viewer"));
    }

    #[test]
    fn reads_opus_duration_with_pre_skip_and_comments() {
        let serial = 11;
        let mut opus_head = b"OpusHead\x01\x02".to_vec();
        opus_head.extend_from_slice(&312u16.to_le_bytes());
        opus_head.extend_from_slice(&48_000u32.to_le_bytes());
        opus_head.extend_from_slice(&0u16.to_le_bytes());
        opus_head.push(0);
        let comments = vorbis_comments(b"OpusTags", &["TITLE=Opus Track", "ARTIST=Artist"]);
        let mut bytes = Vec::new();
        bytes.extend(page(serial, 0, 0x02, &[opus_head]));
        bytes.extend(page(serial, 0, 0, &[comments]));
        bytes.extend(page(serial, 48_312, 0x04, &[b"audio".to_vec()]));
        let len = bytes.len() as u64;

        let detail = read_ogg_detail(&mut Cursor::new(bytes), len)
            .unwrap()
            .expect("Opus detail");
        assert_eq!(detail.codec.as_deref(), Some("opus"));
        assert_eq!(detail.duration_ms, Some(1_000));
        assert_eq!(detail.title.as_deref(), Some("Opus Track"));
        assert_eq!(detail.artist.as_deref(), Some("Artist"));
    }

    #[test]
    fn returns_none_for_non_ogg_input() {
        let bytes = b"not an ogg file".to_vec();
        let len = bytes.len() as u64;
        assert!(read_ogg_detail(&mut Cursor::new(bytes), len)
            .unwrap()
            .is_none());
    }

    #[test]
    fn converts_opus_granule_after_pre_skip() {
        assert_eq!(
            duration_from_granule(OggCodec::Opus { pre_skip: 312 }, 96_312),
            Some(2_000)
        );
        assert_eq!(
            duration_from_granule(OggCodec::Opus { pre_skip: 400 }, 300),
            None
        );
    }

    fn vorbis_identification(sample_rate: u32) -> Vec<u8> {
        let mut packet = b"\x01vorbis".to_vec();
        packet.extend_from_slice(&0u32.to_le_bytes());
        packet.push(2);
        packet.extend_from_slice(&sample_rate.to_le_bytes());
        packet.extend_from_slice(&0i32.to_le_bytes());
        packet.extend_from_slice(&0i32.to_le_bytes());
        packet.extend_from_slice(&0i32.to_le_bytes());
        packet.push(0xb8);
        packet.push(1);
        packet
    }

    fn vorbis_comments(prefix: &[u8], comments: &[&str]) -> Vec<u8> {
        let mut packet = prefix.to_vec();
        let vendor = b"WaterfallViewer";
        packet.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        packet.extend_from_slice(vendor);
        packet.extend_from_slice(&(comments.len() as u32).to_le_bytes());
        for comment in comments {
            packet.extend_from_slice(&(comment.len() as u32).to_le_bytes());
            packet.extend_from_slice(comment.as_bytes());
        }
        if prefix == b"\x03vorbis" {
            packet.push(1);
        }
        packet
    }

    fn page(serial: u32, granule: u64, header_type: u8, packets: &[Vec<u8>]) -> Vec<u8> {
        let mut lacing = Vec::new();
        let mut payload = Vec::new();
        for packet in packets {
            let mut remaining = packet.as_slice();
            while remaining.len() >= 255 {
                lacing.push(255);
                payload.extend_from_slice(&remaining[..255]);
                remaining = &remaining[255..];
            }
            lacing.push(remaining.len() as u8);
            payload.extend_from_slice(remaining);
        }
        assert!(lacing.len() <= 255);

        let mut output = b"OggS".to_vec();
        output.push(0);
        output.push(header_type);
        output.extend_from_slice(&granule.to_le_bytes());
        output.extend_from_slice(&serial.to_le_bytes());
        output.extend_from_slice(&0u32.to_le_bytes());
        output.extend_from_slice(&0u32.to_le_bytes());
        output.push(lacing.len() as u8);
        output.extend_from_slice(&lacing);
        output.extend_from_slice(&payload);
        output
    }
}
