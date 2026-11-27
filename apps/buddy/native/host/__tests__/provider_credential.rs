use super::*;

fn frame(op: u8, payload: &[u8]) -> Vec<u8> {
    [
        MAGIC.as_slice(),
        &[op],
        &(payload.len() as u32).to_le_bytes(),
        payload,
    ]
    .concat()
}

fn rejected(request: &[u8]) {
    let mut output = Vec::new();
    assert!(process(request, &mut output).is_err());
    assert!(output.is_empty());
}

#[test]
fn round_trips_only_the_synthetic_utf8_payload() {
    for text in ["", "\u{feff}测试\0fake🔐", &"a".repeat(MAX_TEXT)] {
        let mut sealed = Vec::new();
        process(frame(SEAL, text.as_bytes()).as_slice(), &mut sealed).unwrap();
        let ciphertext = &sealed[HEADER..];
        assert_eq!(sealed, frame(RESPONSE | SEAL, ciphertext));
        let mut opened = Vec::new();
        process(frame(OPEN, ciphertext).as_slice(), &mut opened).unwrap();
        assert_eq!(opened, frame(RESPONSE | OPEN, text.as_bytes()));
        rejected(&frame(OPEN, &ciphertext[..ciphertext.len() / 2]));
    }
}

#[test]
fn malformed_requests_emit_nothing() {
    rejected(&frame(OPEN, b""));
    rejected(&frame(OPEN, b"not a DPAPI blob"));
    rejected(&frame(RESPONSE | SEAL, b"fake"));
    rejected(&frame(SEAL, &[0xff]));
    let mut bad = frame(SEAL, b"fake");
    rejected(&bad[..HEADER - 1]);
    rejected(&bad[..bad.len() - 1]);
    bad.push(0);
    rejected(&bad);
    bad[4] = 2;
    rejected(&bad[..bad.len() - 1]);
    for (op, limit) in [(SEAL, MAX_TEXT), (OPEN, MAX_BLOB)] {
        let mut header = frame(op, b"");
        header[6..].copy_from_slice(&(limit as u32 + 1).to_le_bytes());
        assert!(request(header.as_slice().try_into().unwrap()).is_err());
    }
}

#[test]
fn even_same_entropy_cannot_open_a_foreign_plaintext_format() {
    for wrong in [
        b"other synthetic data".as_slice(),
        &frame(OPEN, b"fake"),
        &frame(SEAL, &[0xff]),
    ] {
        let blob = dpapi(SEAL, wrong).unwrap();
        rejected(&frame(OPEN, blob.bytes()));
    }
}

#[test]
fn valid_inner_frame_sealed_without_lexora_entropy_is_rejected() {
    let bytes = frame(SEAL, b"synthetic");
    let data = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input borrows the fixed test frame; output receives a LocalAlloc blob on success.
    let ok = unsafe {
        CryptProtectData(
            &data,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    assert_ne!(ok, 0);
    assert!(!output.pbData.is_null());
    let foreign = LocalBlob(output);
    rejected(&frame(OPEN, foreign.bytes()));
}
