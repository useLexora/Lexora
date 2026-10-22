#[cfg(test)]
use lexora_buddy_host::file_reader::{ReadError, run, run_batch, run_stream};

fn file_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    #[cfg(windows)]
    let root = {
        let path = root.to_str().unwrap();
        if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
            std::path::PathBuf::from(format!(r"\\{path}"))
        } else {
            std::path::PathBuf::from(path.strip_prefix(r"\\?\").unwrap())
        }
    };
    (directory, root)
}

fn stream_file_id(path: &std::path::Path) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path).unwrap();
        format!("{}:{}", metadata.dev(), metadata.ino())
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let file = std::fs::File::open(path).unwrap();
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        assert_ne!(
            // SAFETY: The file owns the live handle; info is initialized and writable.
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) },
            0
        );
        let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        format!("{}:{index}", info.dwVolumeSerialNumber)
    }
}

fn stream_input(
    root: &std::path::Path,
    size: u64,
    start: u64,
    length: u64,
    permit: bool,
) -> Vec<u8> {
    let mut input = serde_json::to_vec(&serde_json::json!({
        "root": root, "path": root.join("media"), "sizeBytes": size, "start": start, "length": length,
        "fileId": stream_file_id(&root.join("media"))
    })).unwrap();
    input.push(b'\n');
    if permit {
        input.push(1);
    }
    input
}

#[test]
fn streams_a_range_of_a_large_sparse_file_and_empty_metadata() {
    use std::io::{Seek, SeekFrom, Write};
    let (_directory, root) = file_fixture();
    let mut file = std::fs::File::create(root.join("media")).unwrap();
    let size = 1024 * 1024 * 1024;
    file.set_len(size).unwrap();
    file.seek(SeekFrom::Start(size - 4)).unwrap();
    file.write_all(b"tail").unwrap();
    drop(file);
    let mut output = Vec::new();
    run_stream(
        stream_input(&root, size, size - 4, 4, true).as_slice(),
        &mut output,
    )
    .unwrap();
    assert_eq!(output, b"\x01tail");
    output.clear();
    run_stream(
        stream_input(&root, size, 0, 0, true).as_slice(),
        &mut output,
    )
    .unwrap();
    assert_eq!(output, [1]);
}

#[test]
fn stream_rejects_invalid_ranges_or_size_changes_before_acknowledging() {
    let (_directory, root) = file_fixture();
    std::fs::write(root.join("media"), b"0123456789").unwrap();
    for (size, start, length) in [(10, 10, 1), (10, u64::MAX, 2), (11, 0, 1), (10, 11, 0)] {
        let mut output = Vec::new();
        assert!(
            run_stream(
                stream_input(&root, size, start, length, true).as_slice(),
                &mut output
            )
            .is_err()
        );
        assert!(output.is_empty());
    }
}

#[test]
fn stream_rejects_same_size_directory_replacement_before_ready() {
    let (_directory, root) = file_fixture();
    let original = root.join("original");
    let replacement = root.join("replacement");
    let parked = root.join("parked");
    std::fs::create_dir(&original).unwrap();
    std::fs::create_dir(&replacement).unwrap();
    std::fs::write(original.join("media"), b"allowed").unwrap();
    std::fs::write(replacement.join("media"), b"private").unwrap();
    let inputs = [0, 7].map(|length| stream_input(&original, 7, 0, length, true));
    std::fs::rename(&original, &parked).unwrap();
    std::fs::rename(&replacement, &original).unwrap();
    for input in inputs {
        let mut output = Vec::new();
        assert!(run_stream(input.as_slice(), &mut output).is_err());
        assert!(output.is_empty());
    }
}

#[test]
fn stream_requires_exact_device_and_full_width_file_id_before_ready() {
    let (_directory, root) = file_fixture();
    std::fs::write(root.join("media"), b"allowed").unwrap();
    let input = stream_input(&root, 7, 0, 7, false);
    let request: serde_json::Value = serde_json::from_slice(&input).unwrap();
    let identity = stream_file_id(&root.join("media"));
    let (device, inode) = identity.split_once(':').unwrap();
    let device = device.parse::<u64>().unwrap();
    let inode = inode.parse::<u64>().unwrap();
    for id in [
        None,
        Some(String::new()),
        Some(format!("{}:{inode}", device ^ 1)),
        Some(format!("{device}:{}", inode ^ (1 << 53))),
    ] {
        let mut request = request.clone();
        if let Some(id) = id {
            request["fileId"] = id.into();
        } else {
            request.as_object_mut().unwrap().remove("fileId");
        }
        let mut input = serde_json::to_vec(&request).unwrap();
        input.extend_from_slice(b"\n\x01");
        let mut output = Vec::new();
        assert!(run_stream(input.as_slice(), &mut output).is_err());
        assert!(output.is_empty());
    }
}

#[test]
fn closing_stream_input_before_confirmation_never_reads_file_contents() {
    let (_directory, root) = file_fixture();
    std::fs::write(root.join("media"), b"private").unwrap();
    let mut output = Vec::new();
    assert!(run_stream(stream_input(&root, 7, 0, 7, false).as_slice(), &mut output).is_err());
    assert_eq!(output, [1]);
}

#[test]
fn rejects_invalid_or_unbounded_requests_without_output() {
    for input in [
        r#"{"root":"C:\\data","path":"C:\\data\\file","maxBytes":-1}"#,
        r#"{"root":"C:\\data","path":"C:\\data\\file","maxBytes":1.5}"#,
        r#"{"root":"C:\\data","path":"C:\\data\\file","maxBytes":67108865}"#,
        r#"{"root":"C:\\data","path":"C:\\data\\file","maxBytes":0,"command":"whoami"}"#,
        "{}",
        &" ".repeat(256 * 1024 + 1),
    ] {
        let mut output = Vec::new();
        assert!(run(input.as_bytes(), &mut output).is_err());
        assert!(output.is_empty());
    }
}

#[test]
fn errors_do_not_disclose_host_paths() {
    assert_eq!(
        ReadError::ReadFailed.to_string(),
        "BOUNDED_FILE_READ_FAILED"
    );
    assert_eq!(
        ReadError::OutputLimit.to_string(),
        "BOUNDED_FILE_OUTPUT_LIMIT"
    );
    assert_eq!(
        ReadError::Unavailable.to_string(),
        "BOUNDED_FILE_READER_UNAVAILABLE"
    );
}

#[test]
fn rejects_unbounded_batches_before_writing_output() {
    let request = r#"{"root":"/data","path":"/data/file","maxBytes":262144}"#;
    let too_many = format!("[{}]", vec![request; 65].join(","));
    for input in [
        too_many.as_str(),
        r#"[{"root":"/data","path":"/data/file","maxBytes":16777217}]"#,
        r#"[{"root":"/data","path":"/data/file","maxBytes":10000000},{"root":"/data","path":"/data/file","maxBytes":10000000}]"#,
        r#"[{"root":"/data","path":"/data/file","maxBytes":1,"command":"extra"}]"#,
    ] {
        let mut output = Vec::new();
        assert!(run_batch(input.as_bytes(), &mut output).is_err());
        assert!(output.is_empty());
    }
}

#[test]
fn batch_frames_preserve_binary_bytes_empty_files_and_individual_failures() {
    let (_directory, root) = file_fixture();
    std::fs::write(root.join("binary"), [0, 255, 10]).unwrap();
    std::fs::write(root.join("empty"), []).unwrap();
    let input = serde_json::to_vec(&serde_json::json!([
        {"root": root, "path": root.join("binary"), "maxBytes": 3},
        {"root": root, "path": root.join("missing"), "maxBytes": 3},
        {"root": root, "path": root.join("binary"), "maxBytes": 2},
        {"root": root, "path": root.join("empty"), "maxBytes": 0},
    ]))
    .unwrap();
    let mut output = Vec::new();
    run_batch(input.as_slice(), &mut output).unwrap();
    assert_eq!(
        output,
        [
            0, 0, 0, 0, 3, 0, 255, 10, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0
        ]
    );
}
