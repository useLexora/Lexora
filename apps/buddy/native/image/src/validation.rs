use super::{ImageError, MAX_IMAGE_PIXELS};
use image::{ImageDecoder, ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use std::io::Cursor;

const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationOptions {
    mime_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageInfo<'a> {
    width: u32,
    height: u32,
    mime_type: &'a str,
}

pub fn validate(bytes: &[u8], options: &ValidationOptions) -> Result<Vec<u8>, ImageError> {
    let format = match options.mime_type.as_str() {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::WebP,
        "image/bmp" => ImageFormat::Bmp,
        _ => return Err(ImageError::InvalidImage),
    };
    if image::guess_format(bytes).map_err(decode_error)? != format {
        return Err(ImageError::InvalidImage);
    }
    if format == ImageFormat::Png {
        let mut header = png::Decoder::new_with_limits(
            Cursor::new(bytes),
            png::Limits {
                bytes: MAX_DECODE_BYTES as usize,
            },
        );
        let info = header.read_header_info().map_err(super::decode_error)?;
        check_dimensions(info.width, info.height)?;
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits.max_image_width = Some(MAX_IMAGE_PIXELS as u32);
    limits.max_image_height = Some(MAX_IMAGE_PIXELS as u32);
    reader.limits(limits);
    let decoder = reader.into_decoder().map_err(decode_error)?;
    let (width, height) = decoder.dimensions();
    check_dimensions(width, height)?;
    let size = decoder.total_bytes();
    if size > MAX_DECODE_BYTES {
        return Err(ImageError::InputTooLarge);
    }
    let mut pixels = vec![0; usize::try_from(size).map_err(|_| ImageError::InputTooLarge)?];
    decoder.read_image(&mut pixels).map_err(decode_error)?;
    serde_json::to_vec(&ImageInfo {
        width,
        height,
        mime_type: &options.mime_type,
    })
    .map_err(|_| ImageError::Failed)
}

fn check_dimensions(width: u32, height: u32) -> Result<(), ImageError> {
    if width == 0 || height == 0 {
        return Err(ImageError::InvalidImage);
    }
    if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err(ImageError::InputTooLarge);
    }
    Ok(())
}

fn decode_error(error: image::ImageError) -> ImageError {
    match error {
        image::ImageError::Limits(_) => ImageError::InputTooLarge,
        _ => ImageError::InvalidImage,
    }
}
