use waterfall_core::{MediaDetail, MediaKind, MetadataReadFailure};

use super::{detail, flac, isobmff_audio, ogg};

pub fn read_media_detail(
    locator: &str,
    kind: &MediaKind,
) -> Result<Option<MediaDetail>, MetadataReadFailure> {
    if matches!(kind, MediaKind::Audio) {
        if let Some(detail) = flac::read_flac_detail_file(locator)? {
            return Ok(Some(MediaDetail::Audio(detail)));
        }
        if let Some(detail) = isobmff_audio::read_iso_bmff_audio_detail_file(locator)? {
            return Ok(Some(MediaDetail::Audio(detail)));
        }
        if let Some(detail) = ogg::read_ogg_detail_file(locator)? {
            return Ok(Some(MediaDetail::Audio(detail)));
        }
    }

    detail::read_media_detail(locator, kind)
}
