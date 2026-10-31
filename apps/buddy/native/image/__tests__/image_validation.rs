use image::{DynamicImage, ImageFormat, RgbImage};
use lexora_buddy_image_transform::run;
use std::io::Cursor;

fn request(bytes: &[u8], mime: &str) -> Result<serde_json::Value, String> {
    let options = serde_json::to_vec(
        &serde_json::json!({"operation":"validate","options":{"mimeType":mime}}),
    )
    .unwrap();
    let mut input = (options.len() as u32).to_be_bytes().to_vec();
    input.extend(options);
    input.extend(bytes);
    let mut output = Vec::new();
    match run(input.as_slice(), &mut output) {
        Ok(()) => Ok(serde_json::from_slice(&output).unwrap()),
        Err(error) => {
            assert!(output.is_empty());
            Err(error.to_string())
        }
    }
}

#[test]
fn fully_decodes_supported_formats_and_rejects_mime_mismatch() {
    for (format, mime) in [
        (ImageFormat::Png, "image/png"),
        (ImageFormat::Jpeg, "image/jpeg"),
        (ImageFormat::Gif, "image/gif"),
        (ImageFormat::WebP, "image/webp"),
        (ImageFormat::Bmp, "image/bmp"),
    ] {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(RgbImage::new(2, 3))
            .write_to(&mut bytes, format)
            .unwrap();
        let bytes = bytes.into_inner();
        assert_eq!(
            request(&bytes, mime).unwrap(),
            serde_json::json!({"width":2,"height":3,"mimeType":mime})
        );
        assert!(request(&bytes[..bytes.len() / 2], mime).is_err());
        assert!(
            request(
                &bytes,
                if mime == "image/png" {
                    "image/jpeg"
                } else {
                    "image/png"
                }
            )
            .is_err()
        );
    }
}

#[test]
fn rejects_excessive_dimensions_before_allocating_pixels() {
    let mut bytes = Vec::new();
    let encoder = png::Encoder::new(&mut bytes, 10_000, 10_000);
    drop(encoder.write_header().unwrap());
    assert_eq!(
        request(&bytes, "image/png").unwrap_err(),
        "IMAGE_TRANSFORM_INPUT_TOO_LARGE"
    );
}
