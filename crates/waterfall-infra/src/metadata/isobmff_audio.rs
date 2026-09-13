use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
};

use waterfall_core::{AudioDetail, MetadataReadFailure};

const MAX_BOXES: usize = 100_000;

pub(super) fn read_iso_bmff_audio_detail_file(
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
    read_iso_bmff_audio_detail(&mut file, file_len).map_err(|error| {
        MetadataReadFailure::new(format!("failed to read ISO-BMFF audio detail: {error}"))
    })
}

#[derive(Clone, Copy)]
struct IsoBox {
    kind: [u8; 4],
    payload_start: u64,
    end: u64,
}

fn read_iso_bmff_audio_detail<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
) -> io::Result<Option<AudioDetail>> {
    let mut cursor = 0u64;
    let mut visited = 0usize;
    while cursor.saturating_add(8) <= file_len && visited < MAX_BOXES {
        let Some(current) = read_iso_box(reader, cursor, file_len)? else {
            return Ok(None);
        };
        visited += 1;
        if &current.kind == b"moov" {
            return read_moov_audio_detail(reader, current).map(Some);
        }
        cursor = current.end;
    }
    Ok(None)
}

fn read_moov_audio_detail<R: Read + Seek>(reader: &mut R, moov: IsoBox) -> io::Result<AudioDetail> {
    let mut cursor = moov.payload_start;
    let mut visited = 0usize;
    let mut duration_ms = None;
    let mut codec = None;

    while cursor.saturating_add(8) <= moov.end && visited < MAX_BOXES {
        let Some(current) = read_iso_box(reader, cursor, moov.end)? else {
            break;
        };
        visited += 1;
        match &current.kind {
            b"mvhd" => duration_ms = read_mvhd_duration(reader, current)?,
            b"trak" if codec.is_none() => codec = read_audio_track_codec(reader, current)?,
            _ => {}
        }
        cursor = current.end;
    }

    Ok(AudioDetail {
        duration_ms,
        title: None,
        artist: None,
        codec,
    })
}

fn read_mvhd_duration<R: Read + Seek>(reader: &mut R, mvhd: IsoBox) -> io::Result<Option<u64>> {
    reader.seek(SeekFrom::Start(mvhd.payload_start))?;
    let mut version_flags = [0u8; 4];
    reader.read_exact(&mut version_flags)?;
    let (timescale_offset, duration_offset, duration_bytes) = if version_flags[0] == 1 {
        (20u64, 24u64, 8usize)
    } else {
        (12u64, 16u64, 4usize)
    };
    if mvhd
        .payload_start
        .saturating_add(duration_offset)
        .saturating_add(duration_bytes as u64)
        > mvhd.end
    {
        return Ok(None);
    }

    reader.seek(SeekFrom::Start(mvhd.payload_start + timescale_offset))?;
    let mut timescale = [0u8; 4];
    reader.read_exact(&mut timescale)?;
    let timescale = u32::from_be_bytes(timescale);
    if timescale == 0 {
        return Ok(None);
    }

    reader.seek(SeekFrom::Start(mvhd.payload_start + duration_offset))?;
    let duration = if duration_bytes == 8 {
        let mut bytes = [0u8; 8];
        reader.read_exact(&mut bytes)?;
        u64::from_be_bytes(bytes)
    } else {
        let mut bytes = [0u8; 4];
        reader.read_exact(&mut bytes)?;
        u64::from(u32::from_be_bytes(bytes))
    };
    Ok(duration
        .checked_mul(1000)
        .map(|value| value / u64::from(timescale)))
}

fn read_audio_track_codec<R: Read + Seek>(
    reader: &mut R,
    trak: IsoBox,
) -> io::Result<Option<String>> {
    let mut cursor = trak.payload_start;
    while cursor.saturating_add(8) <= trak.end {
        let Some(current) = read_iso_box(reader, cursor, trak.end)? else {
            break;
        };
        if &current.kind == b"mdia" {
            return read_mdia_audio_codec(reader, current);
        }
        cursor = current.end;
    }
    Ok(None)
}

fn read_mdia_audio_codec<R: Read + Seek>(
    reader: &mut R,
    mdia: IsoBox,
) -> io::Result<Option<String>> {
    let mut cursor = mdia.payload_start;
    let mut is_audio = false;
    let mut minf = None;
    while cursor.saturating_add(8) <= mdia.end {
        let Some(current) = read_iso_box(reader, cursor, mdia.end)? else {
            break;
        };
        match &current.kind {
            b"hdlr" => is_audio = read_handler_is_audio(reader, current)?,
            b"minf" => minf = Some(current),
            _ => {}
        }
        cursor = current.end;
    }
    if !is_audio {
        return Ok(None);
    }
    match minf {
        Some(minf) => read_minf_codec(reader, minf),
        None => Ok(None),
    }
}

fn read_handler_is_audio<R: Read + Seek>(reader: &mut R, hdlr: IsoBox) -> io::Result<bool> {
    let offset = hdlr.payload_start.saturating_add(8);
    if offset.saturating_add(4) > hdlr.end {
        return Ok(false);
    }
    reader.seek(SeekFrom::Start(offset))?;
    let mut handler = [0u8; 4];
    reader.read_exact(&mut handler)?;
    Ok(&handler == b"soun")
}

fn read_minf_codec<R: Read + Seek>(reader: &mut R, minf: IsoBox) -> io::Result<Option<String>> {
    let mut cursor = minf.payload_start;
    while cursor.saturating_add(8) <= minf.end {
        let Some(current) = read_iso_box(reader, cursor, minf.end)? else {
            break;
        };
        if &current.kind == b"stbl" {
            return read_stbl_codec(reader, current);
        }
        cursor = current.end;
    }
    Ok(None)
}

fn read_stbl_codec<R: Read + Seek>(reader: &mut R, stbl: IsoBox) -> io::Result<Option<String>> {
    let mut cursor = stbl.payload_start;
    while cursor.saturating_add(8) <= stbl.end {
        let Some(current) = read_iso_box(reader, cursor, stbl.end)? else {
            break;
        };
        if &current.kind == b"stsd" {
            if current.payload_start.saturating_add(16) > current.end {
                return Ok(None);
            }
            reader.seek(SeekFrom::Start(current.payload_start + 12))?;
            let mut codec = [0u8; 4];
            reader.read_exact(&mut codec)?;
            return Ok(Some(String::from_utf8_lossy(&codec).into_owned()));
        }
        cursor = current.end;
    }
    Ok(None)
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
    let kind: [u8; 4] = header[4..8].try_into().expect("four-byte kind");
    let mut header_len = 8u64;
    let size = match size32 {
        0 => parent_end.saturating_sub(start),
        1 => {
            let mut extended = [0u8; 8];
            reader.read_exact(&mut extended)?;
            header_len = 16;
            u64::from_be_bytes(extended)
        }
        value => u64::from(value),
    };
    if &kind == b"uuid" {
        header_len += 16;
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
    Ok(Some(IsoBox {
        kind,
        payload_start,
        end,
    }))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::read_iso_bmff_audio_detail;

    #[test]
    fn reads_m4a_duration_and_audio_codec() {
        let mvhd = full_box(b"mvhd", &mvhd_payload(1_000, 12_345));
        let hdlr = full_box(b"hdlr", &handler_payload(b"soun"));
        let stsd = full_box(b"stsd", &stsd_payload(b"mp4a"));
        let stbl = boxed(b"stbl", &stsd);
        let minf = boxed(b"minf", &stbl);
        let mdia = boxed(b"mdia", &[hdlr, minf].concat());
        let trak = boxed(b"trak", &mdia);
        let moov = boxed(b"moov", &[mvhd, trak].concat());
        let ftyp = boxed(b"ftyp", b"M4A \0\0\0\0M4A ");
        let bytes = [ftyp, moov].concat();
        let len = bytes.len() as u64;

        let detail = read_iso_bmff_audio_detail(&mut Cursor::new(bytes), len)
            .unwrap()
            .expect("ISO-BMFF audio detail");
        assert_eq!(detail.duration_ms, Some(12_345));
        assert_eq!(detail.codec.as_deref(), Some("mp4a"));
    }

    #[test]
    fn ignores_video_track_when_looking_for_audio_codec() {
        let mvhd = full_box(b"mvhd", &mvhd_payload(1_000, 2_000));
        let hdlr = full_box(b"hdlr", &handler_payload(b"vide"));
        let stsd = full_box(b"stsd", &stsd_payload(b"avc1"));
        let stbl = boxed(b"stbl", &stsd);
        let minf = boxed(b"minf", &stbl);
        let mdia = boxed(b"mdia", &[hdlr, minf].concat());
        let trak = boxed(b"trak", &mdia);
        let moov = boxed(b"moov", &[mvhd, trak].concat());
        let len = moov.len() as u64;

        let detail = read_iso_bmff_audio_detail(&mut Cursor::new(moov), len)
            .unwrap()
            .expect("ISO-BMFF detail");
        assert_eq!(detail.duration_ms, Some(2_000));
        assert_eq!(detail.codec, None);
    }

    #[test]
    fn returns_none_for_non_iso_bmff_data() {
        let bytes = b"not an isobmff file".to_vec();
        let len = bytes.len() as u64;
        assert!(read_iso_bmff_audio_detail(&mut Cursor::new(bytes), len)
            .unwrap()
            .is_none());
    }

    fn boxed(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let size = 8usize.checked_add(payload.len()).unwrap();
        let mut output = Vec::with_capacity(size);
        output.extend_from_slice(&(size as u32).to_be_bytes());
        output.extend_from_slice(kind);
        output.extend_from_slice(payload);
        output
    }

    fn full_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        boxed(kind, payload)
    }

    fn mvhd_payload(timescale: u32, duration: u32) -> Vec<u8> {
        let mut payload = vec![0u8; 20];
        payload[12..16].copy_from_slice(&timescale.to_be_bytes());
        payload[16..20].copy_from_slice(&duration.to_be_bytes());
        payload
    }

    fn handler_payload(handler: &[u8; 4]) -> Vec<u8> {
        let mut payload = vec![0u8; 12];
        payload[8..12].copy_from_slice(handler);
        payload
    }

    fn stsd_payload(codec: &[u8; 4]) -> Vec<u8> {
        let mut payload = vec![0u8; 16];
        payload[4..8].copy_from_slice(&1u32.to_be_bytes());
        payload[12..16].copy_from_slice(codec);
        payload
    }
}
