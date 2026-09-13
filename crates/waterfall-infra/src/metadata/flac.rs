use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
};

use waterfall_core::{AudioDetail, MetadataReadFailure};

const MAX_METADATA_BLOCKS: usize = 128;
const MAX_VORBIS_COMMENT_BYTES: u64 = 2 * 1024 * 1024;
const STREAMINFO_BYTES: usize = 34;

pub(super) fn read_flac_detail_file(
    locator: &str,
) -> Result<Option<AudioDetail>, MetadataReadFailure> {
    let mut file = File::open(locator).map_err(|error| {
        MetadataReadFailure::new(format!("failed to open audio detail: {error}"))
    })?;
    read_flac_detail(&mut file)
        .map_err(|error| MetadataReadFailure::new(format!("failed to read FLAC detail: {error}")))
}

fn read_flac_detail<R: Read + Seek>(reader: &mut R) -> io::Result<Option<AudioDetail>> {
    reader.seek(SeekFrom::Start(0))?;
    let mut magic = [0u8; 4];
    match reader.read_exact(&mut magic) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    if &magic != b"fLaC" {
        return Ok(None);
    }

    let mut detail = AudioDetail {
        codec: Some("flac".to_string()),
        ..AudioDetail::default()
    };

    for _ in 0..MAX_METADATA_BLOCKS {
        let mut block_header = [0u8; 4];
        reader.read_exact(&mut block_header)?;
        let is_last = block_header[0] & 0x80 != 0;
        let block_type = block_header[0] & 0x7f;
        let block_len = u64::from(u32::from_be_bytes([
            0,
            block_header[1],
            block_header[2],
            block_header[3],
        ]));

        match block_type {
            0 => read_streaminfo(reader, block_len, &mut detail)?,
            4 if block_len <= MAX_VORBIS_COMMENT_BYTES => {
                let mut body = vec![0u8; block_len as usize];
                reader.read_exact(&mut body)?;
                read_vorbis_comments(&body, &mut detail);
            }
            _ => {
                reader.seek(SeekFrom::Current(i64::try_from(block_len).map_err(
                    |_| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            "FLAC metadata block is too large",
                        )
                    },
                )?))?;
            }
        }

        if is_last {
            return Ok(Some(detail));
        }
    }

    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "too many FLAC metadata blocks",
    ))
}

fn read_streaminfo<R: Read + Seek>(
    reader: &mut R,
    block_len: u64,
    detail: &mut AudioDetail,
) -> io::Result<()> {
    if block_len < STREAMINFO_BYTES as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "FLAC STREAMINFO block is shorter than 34 bytes",
        ));
    }

    let mut streaminfo = [0u8; STREAMINFO_BYTES];
    reader.read_exact(&mut streaminfo)?;
    if block_len > STREAMINFO_BYTES as u64 {
        reader.seek(SeekFrom::Current(
            i64::try_from(block_len - STREAMINFO_BYTES as u64).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "FLAC STREAMINFO block is too large",
                )
            })?,
        ))?;
    }

    let packed = u64::from_be_bytes(
        streaminfo[10..18]
            .try_into()
            .expect("FLAC packed stream info is eight bytes"),
    );
    let sample_rate = (packed >> 44) & 0x000f_ffff;
    let total_samples = packed & 0x0000_000f_ffff_ffff;
    if sample_rate > 0 {
        detail.duration_ms = total_samples
            .checked_mul(1000)
            .map(|samples| samples / sample_rate);
    }
    Ok(())
}

fn read_vorbis_comments(data: &[u8], detail: &mut AudioDetail) {
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
        if detail.title.is_none() && key.eq_ignore_ascii_case("TITLE") {
            detail.title = Some(value.to_string());
        } else if detail.artist.is_none() && key.eq_ignore_ascii_case("ARTIST") {
            detail.artist = Some(value.to_string());
        }
    }
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

    use super::read_flac_detail;

    #[test]
    fn reads_streaminfo_duration_and_codec() {
        let data = flac_fixture(48_000, 144_000, &[]);
        let detail = read_flac_detail(&mut Cursor::new(data))
            .unwrap()
            .expect("FLAC detail");

        assert_eq!(detail.duration_ms, Some(3_000));
        assert_eq!(detail.codec.as_deref(), Some("flac"));
        assert_eq!(detail.title, None);
        assert_eq!(detail.artist, None);
    }

    #[test]
    fn reads_vorbis_title_and_artist() {
        let data = flac_fixture(
            44_100,
            88_200,
            &["TITLE=Waterfall", "artist=OpenAI", "ALBUM=Ignored"],
        );
        let detail = read_flac_detail(&mut Cursor::new(data))
            .unwrap()
            .expect("FLAC detail");

        assert_eq!(detail.duration_ms, Some(2_000));
        assert_eq!(detail.title.as_deref(), Some("Waterfall"));
        assert_eq!(detail.artist.as_deref(), Some("OpenAI"));
    }

    #[test]
    fn ignores_non_flac_input() {
        let detail = read_flac_detail(&mut Cursor::new(b"RIFFnot-flac".to_vec())).unwrap();
        assert!(detail.is_none());
    }

    #[test]
    fn rejects_truncated_vorbis_comments() {
        let mut data = flac_fixture(48_000, 48_000, &["TITLE=Complete"]);
        data.truncate(data.len() - 3);

        assert!(read_flac_detail(&mut Cursor::new(data)).is_err());
    }

    fn flac_fixture(sample_rate: u64, total_samples: u64, comments: &[&str]) -> Vec<u8> {
        assert!(sample_rate <= 0x000f_ffff);
        assert!(total_samples <= 0x0000_000f_ffff_ffff);

        let mut output = b"fLaC".to_vec();
        let mut streaminfo = [0u8; 34];
        let packed = (sample_rate << 44) | (1u64 << 41) | (15u64 << 36) | total_samples;
        streaminfo[10..18].copy_from_slice(&packed.to_be_bytes());

        let streaminfo_is_last = comments.is_empty();
        push_block(&mut output, streaminfo_is_last, 0, &streaminfo);
        if !comments.is_empty() {
            let mut body = Vec::new();
            let vendor = b"WaterfallViewer";
            body.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
            body.extend_from_slice(vendor);
            body.extend_from_slice(&(comments.len() as u32).to_le_bytes());
            for comment in comments {
                body.extend_from_slice(&(comment.len() as u32).to_le_bytes());
                body.extend_from_slice(comment.as_bytes());
            }
            push_block(&mut output, true, 4, &body);
        }
        output
    }

    fn push_block(output: &mut Vec<u8>, is_last: bool, block_type: u8, body: &[u8]) {
        assert!(body.len() <= 0x00ff_ffff);
        output.push(block_type | if is_last { 0x80 } else { 0 });
        let len = body.len() as u32;
        output.extend_from_slice(&len.to_be_bytes()[1..]);
        output.extend_from_slice(body);
    }
}
