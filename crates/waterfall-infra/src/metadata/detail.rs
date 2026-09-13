use std::{fs::File, io::{self, Read, Seek, SeekFrom}};

use waterfall_core::{AudioDetail, MediaDetail, MediaKind, MetadataReadFailure, VideoDetail};

const ID3_READ_LIMIT: u64 = 2 * 1024 * 1024;
const MAX_BOXES: usize = 100_000;

pub fn read_media_detail(
    locator: &str,
    kind: &MediaKind,
) -> Result<Option<MediaDetail>, MetadataReadFailure> {
    match kind {
        MediaKind::Video => read_video_detail(locator).map(Some),
        MediaKind::Audio => read_audio_detail(locator).map(Some),
        MediaKind::Image | MediaKind::AnimatedImage => Ok(None),
    }
}

fn read_video_detail(locator: &str) -> Result<MediaDetail, MetadataReadFailure> {
    let mut file = File::open(locator)
        .map_err(|error| MetadataReadFailure::new(format!("failed to open video detail: {error}")))?;
    let file_len = file
        .metadata()
        .map_err(|error| MetadataReadFailure::new(format!("failed to inspect video detail: {error}")))?
        .len();

    let detail = read_iso_bmff_detail(&mut file, file_len)
        .map_err(|error| MetadataReadFailure::new(format!("failed to read video detail: {error}")))?
        .unwrap_or_default();
    Ok(MediaDetail::Video(detail))
}

fn read_audio_detail(locator: &str) -> Result<MediaDetail, MetadataReadFailure> {
    let mut file = File::open(locator)
        .map_err(|error| MetadataReadFailure::new(format!("failed to open audio detail: {error}")))?;
    let file_len = file
        .metadata()
        .map_err(|error| MetadataReadFailure::new(format!("failed to inspect audio detail: {error}")))?
        .len();

    let mut detail = AudioDetail::default();
    if let Some(wav) = read_wav_detail(&mut file, file_len)
        .map_err(|error| MetadataReadFailure::new(format!("failed to read WAV detail: {error}")))?
    {
        detail = wav;
    } else {
        file.seek(SeekFrom::Start(0)).map_err(|error| MetadataReadFailure::new(error.to_string()))?;
        let mut header = Vec::with_capacity(file_len.min(ID3_READ_LIMIT) as usize);
        file.take(ID3_READ_LIMIT)
            .read_to_end(&mut header)
            .map_err(|error| MetadataReadFailure::new(format!("failed to read audio tags: {error}")))?;
        read_id3v2_tags(&header, &mut detail);
        if header.starts_with(b"ID3") || header.windows(2).any(|bytes| bytes == [0xff, 0xfb] || bytes == [0xff, 0xf3] || bytes == [0xff, 0xf2]) {
            detail.codec = Some("mp3".to_string());
        }
    }

    Ok(MediaDetail::Audio(detail))
}

#[derive(Clone, Copy)]
struct IsoBox {
    kind: [u8; 4],
    payload_start: u64,
    end: u64,
}

fn read_iso_bmff_detail<R: Read + Seek>(reader: &mut R, file_len: u64) -> io::Result<Option<VideoDetail>> {
    let mut cursor = 0u64;
    let mut visited = 0usize;
    while cursor.saturating_add(8) <= file_len && visited < MAX_BOXES {
        let Some(current) = read_iso_box(reader, cursor, file_len)? else { return Ok(None); };
        visited += 1;
        if &current.kind == b"moov" {
            return read_moov_detail(reader, current).map(Some);
        }
        cursor = current.end;
    }
    Ok(None)
}

fn read_moov_detail<R: Read + Seek>(reader: &mut R, moov: IsoBox) -> io::Result<VideoDetail> {
    let mut cursor = moov.payload_start;
    let mut visited = 0usize;
    let mut duration_ms = None;
    let mut codec = None;

    while cursor.saturating_add(8) <= moov.end && visited < MAX_BOXES {
        let Some(current) = read_iso_box(reader, cursor, moov.end)? else { break; };
        visited += 1;
        match &current.kind {
            b"mvhd" => duration_ms = read_mvhd_duration(reader, current)?,
            b"trak" if codec.is_none() => codec = read_video_track_codec(reader, current)?,
            _ => {}
        }
        cursor = current.end;
    }

    Ok(VideoDetail { duration_ms, codec })
}

fn read_mvhd_duration<R: Read + Seek>(reader: &mut R, mvhd: IsoBox) -> io::Result<Option<u64>> {
    reader.seek(SeekFrom::Start(mvhd.payload_start))?;
    let mut version_flags = [0u8; 4];
    reader.read_exact(&mut version_flags)?;
    let version = version_flags[0];
    let (timescale_offset, duration_offset, duration_bytes) = if version == 1 { (20u64, 24u64, 8usize) } else { (12u64, 16u64, 4usize) };
    if mvhd.payload_start.saturating_add(duration_offset).saturating_add(duration_bytes as u64) > mvhd.end {
        return Ok(None);
    }

    reader.seek(SeekFrom::Start(mvhd.payload_start + timescale_offset))?;
    let mut scale = [0u8; 4];
    reader.read_exact(&mut scale)?;
    let timescale = u32::from_be_bytes(scale);
    if timescale == 0 { return Ok(None); }

    reader.seek(SeekFrom::Start(mvhd.payload_start + duration_offset))?;
    let duration = if duration_bytes == 8 {
        let mut bytes = [0u8; 8]; reader.read_exact(&mut bytes)?; u64::from_be_bytes(bytes)
    } else {
        let mut bytes = [0u8; 4]; reader.read_exact(&mut bytes)?; u64::from(u32::from_be_bytes(bytes))
    };
    Ok(duration.checked_mul(1000).map(|value| value / u64::from(timescale)))
}

fn read_video_track_codec<R: Read + Seek>(reader: &mut R, trak: IsoBox) -> io::Result<Option<String>> {
    let mut cursor = trak.payload_start;
    while cursor.saturating_add(8) <= trak.end {
        let Some(current) = read_iso_box(reader, cursor, trak.end)? else { break; };
        if &current.kind == b"mdia" {
            return read_mdia_codec(reader, current);
        }
        cursor = current.end;
    }
    Ok(None)
}

fn read_mdia_codec<R: Read + Seek>(reader: &mut R, mdia: IsoBox) -> io::Result<Option<String>> {
    let mut cursor = mdia.payload_start;
    let mut is_video = false;
    let mut minf = None;
    while cursor.saturating_add(8) <= mdia.end {
        let Some(current) = read_iso_box(reader, cursor, mdia.end)? else { break; };
        match &current.kind {
            b"hdlr" => is_video = read_handler_is_video(reader, current)?,
            b"minf" => minf = Some(current),
            _ => {}
        }
        cursor = current.end;
    }
    if !is_video { return Ok(None); }
    match minf { Some(minf) => read_minf_codec(reader, minf), None => Ok(None) }
}

fn read_handler_is_video<R: Read + Seek>(reader: &mut R, hdlr: IsoBox) -> io::Result<bool> {
    let offset = hdlr.payload_start.saturating_add(8);
    if offset.saturating_add(4) > hdlr.end { return Ok(false); }
    reader.seek(SeekFrom::Start(offset))?;
    let mut handler = [0u8; 4]; reader.read_exact(&mut handler)?;
    Ok(&handler == b"vide")
}

fn read_minf_codec<R: Read + Seek>(reader: &mut R, minf: IsoBox) -> io::Result<Option<String>> {
    let mut cursor = minf.payload_start;
    while cursor.saturating_add(8) <= minf.end {
        let Some(current) = read_iso_box(reader, cursor, minf.end)? else { break; };
        if &current.kind == b"stbl" { return read_stbl_codec(reader, current); }
        cursor = current.end;
    }
    Ok(None)
}

fn read_stbl_codec<R: Read + Seek>(reader: &mut R, stbl: IsoBox) -> io::Result<Option<String>> {
    let mut cursor = stbl.payload_start;
    while cursor.saturating_add(8) <= stbl.end {
        let Some(current) = read_iso_box(reader, cursor, stbl.end)? else { break; };
        if &current.kind == b"stsd" {
            if current.payload_start.saturating_add(16) > current.end { return Ok(None); }
            reader.seek(SeekFrom::Start(current.payload_start + 12))?;
            let mut codec = [0u8; 4]; reader.read_exact(&mut codec)?;
            return Ok(Some(String::from_utf8_lossy(&codec).into_owned()));
        }
        cursor = current.end;
    }
    Ok(None)
}

fn read_iso_box<R: Read + Seek>(reader: &mut R, start: u64, parent_end: u64) -> io::Result<Option<IsoBox>> {
    if start.saturating_add(8) > parent_end { return Ok(None); }
    reader.seek(SeekFrom::Start(start))?;
    let mut header = [0u8; 8]; reader.read_exact(&mut header)?;
    let size32 = u32::from_be_bytes(header[..4].try_into().expect("four-byte size"));
    let kind: [u8; 4] = header[4..8].try_into().expect("four-byte kind");
    let mut header_len = 8u64;
    let size = match size32 {
        0 => parent_end.saturating_sub(start),
        1 => { let mut extended = [0u8; 8]; reader.read_exact(&mut extended)?; header_len = 16; u64::from_be_bytes(extended) }
        value => u64::from(value),
    };
    if &kind == b"uuid" { header_len += 16; }
    if size < header_len { return Ok(None); }
    let Some(end) = start.checked_add(size) else { return Ok(None); };
    if end > parent_end { return Ok(None); }
    let Some(payload_start) = start.checked_add(header_len) else { return Ok(None); };
    Ok(Some(IsoBox { kind, payload_start, end }))
}

fn read_wav_detail<R: Read + Seek>(reader: &mut R, file_len: u64) -> io::Result<Option<AudioDetail>> {
    if file_len < 12 { return Ok(None); }
    reader.seek(SeekFrom::Start(0))?;
    let mut header = [0u8; 12]; reader.read_exact(&mut header)?;
    if &header[..4] != b"RIFF" || &header[8..12] != b"WAVE" { return Ok(None); }

    let mut cursor = 12u64;
    let mut byte_rate = None;
    let mut format_tag = None;
    let mut data_size = None;
    while cursor.saturating_add(8) <= file_len {
        reader.seek(SeekFrom::Start(cursor))?;
        let mut chunk = [0u8; 8]; reader.read_exact(&mut chunk)?;
        let size = u64::from(u32::from_le_bytes(chunk[4..8].try_into().expect("chunk size")));
        let payload = cursor + 8;
        if &chunk[..4] == b"fmt " && size >= 12 && payload.saturating_add(12) <= file_len {
            let mut fmt = [0u8; 12]; reader.read_exact(&mut fmt)?;
            format_tag = Some(u16::from_le_bytes(fmt[..2].try_into().expect("format tag")));
            byte_rate = Some(u32::from_le_bytes(fmt[8..12].try_into().expect("byte rate")));
        } else if &chunk[..4] == b"data" {
            data_size = Some(size.min(file_len.saturating_sub(payload)));
        }
        let padded = size.saturating_add(size % 2);
        cursor = payload.saturating_add(padded);
    }

    let duration_ms = match (data_size, byte_rate) {
        (Some(data), Some(rate)) if rate > 0 => data.checked_mul(1000).map(|value| value / u64::from(rate)),
        _ => None,
    };
    let codec = format_tag.map(|tag| match tag {
        1 => "pcm".to_string(),
        3 => "ieee-float".to_string(),
        0xfffe => "wave-extensible".to_string(),
        other => format!("wav-0x{other:04x}"),
    });
    Ok(Some(AudioDetail { duration_ms, title: None, artist: None, codec }))
}

fn read_id3v2_tags(data: &[u8], detail: &mut AudioDetail) {
    if data.len() < 10 || &data[..3] != b"ID3" { return; }
    let version = data[3];
    if version != 3 && version != 4 { return; }
    let tag_size = synchsafe_u32(&data[6..10]).unwrap_or(0) as usize;
    let end = 10usize.saturating_add(tag_size).min(data.len());
    let mut cursor = 10usize;
    while cursor.saturating_add(10) <= end {
        let id = &data[cursor..cursor + 4];
        if id.iter().all(|byte| *byte == 0) { break; }
        let size_bytes = &data[cursor + 4..cursor + 8];
        let size = if version == 4 { synchsafe_u32(size_bytes).unwrap_or(0) } else { u32::from_be_bytes(size_bytes.try_into().expect("frame size")) } as usize;
        let payload_start = cursor + 10;
        let payload_end = payload_start.saturating_add(size).min(end);
        if payload_start >= payload_end { break; }
        match id {
            b"TIT2" => detail.title = decode_id3_text(&data[payload_start..payload_end]),
            b"TPE1" => detail.artist = decode_id3_text(&data[payload_start..payload_end]),
            _ => {}
        }
        cursor = payload_end;
    }
}

fn decode_id3_text(data: &[u8]) -> Option<String> {
    let encoding = *data.first()?;
    let body = &data[1..];
    let text = match encoding {
        0 | 3 => String::from_utf8_lossy(body).trim_end_matches('\0').trim().to_string(),
        1 | 2 => {
            let mut units = Vec::with_capacity(body.len() / 2);
            let be = encoding == 2 || !(body.len() >= 2 && body[0] == 0xff && body[1] == 0xfe);
            let start = if encoding == 1 && body.len() >= 2 && ((body[0] == 0xff && body[1] == 0xfe) || (body[0] == 0xfe && body[1] == 0xff)) { 2 } else { 0 };
            for chunk in body[start..].chunks_exact(2) {
                units.push(if be { u16::from_be_bytes([chunk[0], chunk[1]]) } else { u16::from_le_bytes([chunk[0], chunk[1]]) });
            }
            String::from_utf16_lossy(&units).trim_end_matches('\0').trim().to_string()
        }
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn synchsafe_u32(data: &[u8]) -> Option<u32> {
    if data.len() != 4 || data.iter().any(|byte| byte & 0x80 != 0) { return None; }
    Some((u32::from(data[0]) << 21) | (u32::from(data[1]) << 14) | (u32::from(data[2]) << 7) | u32::from(data[3]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn reads_mp4_duration_from_mvhd() {
        let mut mvhd = vec![0u8; 28];
        mvhd[..4].copy_from_slice(&28u32.to_be_bytes());
        mvhd[4..8].copy_from_slice(b"mvhd");
        mvhd[20..24].copy_from_slice(&1000u32.to_be_bytes());
        mvhd[24..28].copy_from_slice(&12_345u32.to_be_bytes());
        let mut cursor = Cursor::new(mvhd.clone());
        let box_info = read_iso_box(&mut cursor, 0, mvhd.len() as u64).unwrap().unwrap();
        assert_eq!(read_mvhd_duration(&mut cursor, box_info).unwrap(), Some(12_345));
    }

    #[test]
    fn reads_wav_duration_and_codec() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&1036u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&48_000u32.to_le_bytes());
        bytes.extend_from_slice(&192_000u32.to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&1000u32.to_le_bytes());
        bytes.resize(bytes.len() + 1000, 0);
        let len = bytes.len() as u64;
        let mut cursor = Cursor::new(bytes);
        let detail = read_wav_detail(&mut cursor, len).unwrap().unwrap();
        assert_eq!(detail.duration_ms, Some(5));
        assert_eq!(detail.codec.as_deref(), Some("pcm"));
    }

    #[test]
    fn reads_id3_title_and_artist() {
        fn frame(id: &[u8; 4], text: &str) -> Vec<u8> {
            let payload = [vec![3u8], text.as_bytes().to_vec()].concat();
            let mut out = Vec::new();
            out.extend_from_slice(id);
            out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            out.extend_from_slice(&[0, 0]);
            out.extend_from_slice(&payload);
            out
        }
        let frames = [frame(b"TIT2", "Track title"), frame(b"TPE1", "Artist")].concat();
        let size = frames.len() as u32;
        let mut data = b"ID3\x03\x00\x00".to_vec();
        data.extend_from_slice(&[((size >> 21) & 0x7f) as u8, ((size >> 14) & 0x7f) as u8, ((size >> 7) & 0x7f) as u8, (size & 0x7f) as u8]);
        data.extend_from_slice(&frames);
        let mut detail = AudioDetail::default();
        read_id3v2_tags(&data, &mut detail);
        assert_eq!(detail.title.as_deref(), Some("Track title"));
        assert_eq!(detail.artist.as_deref(), Some("Artist"));
    }
}
