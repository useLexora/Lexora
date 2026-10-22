use std::{
    fs::File,
    io::{BufRead, Read, Seek, SeekFrom, Write},
};

use serde::Deserialize;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES: u64 = 256 * 1024;
const MAX_BATCH_FILES: usize = 64;
const MAX_BATCH_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("BOUNDED_FILE_OUTPUT_LIMIT")]
    OutputLimit,
    #[error("BOUNDED_FILE_READ_FAILED")]
    ReadFailed,
    #[error("BOUNDED_FILE_READER_UNAVAILABLE")]
    Unavailable,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadRequest {
    pub root: String,
    pub path: String,
    pub max_bytes: u64,
}

pub fn read_request(input: impl Read) -> Result<ReadRequest, ReadError> {
    let mut bytes = Vec::new();
    input
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ReadError::ReadFailed)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(ReadError::ReadFailed);
    }
    let request: ReadRequest = serde_json::from_slice(&bytes).map_err(|_| ReadError::ReadFailed)?;
    if request.max_bytes > MAX_FILE_BYTES {
        return Err(ReadError::OutputLimit);
    }
    Ok(request)
}

pub fn run(input: impl Read, mut output: impl Write) -> Result<(), ReadError> {
    let request = read_request(input)?;
    let bytes = read_bounded_file(&request)?;
    output.write_all(&bytes).map_err(|_| ReadError::ReadFailed)
}

pub fn run_batch(input: impl Read, mut output: impl Write) -> Result<(), ReadError> {
    let mut bytes = Vec::new();
    input
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ReadError::ReadFailed)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(ReadError::ReadFailed);
    }
    let requests: Vec<ReadRequest> =
        serde_json::from_slice(&bytes).map_err(|_| ReadError::ReadFailed)?;
    if requests.len() > MAX_BATCH_FILES
        || requests
            .iter()
            .any(|request| request.max_bytes > MAX_BATCH_BYTES)
        || requests
            .iter()
            .map(|request| request.max_bytes)
            .sum::<u64>()
            > MAX_BATCH_BYTES
    {
        return Err(ReadError::OutputLimit);
    }
    for request in &requests {
        let (status, contents) = match read_bounded_file(request) {
            Ok(contents) => (0, contents),
            Err(ReadError::ReadFailed) => (1, Vec::new()),
            Err(ReadError::OutputLimit) => (2, Vec::new()),
            Err(ReadError::Unavailable) => (3, Vec::new()),
        };
        // Each frame is status:u8, length:u32be, followed by the file bytes.
        let length = u32::try_from(contents.len()).map_err(|_| ReadError::OutputLimit)?;
        output
            .write_all(&[status])
            .map_err(|_| ReadError::ReadFailed)?;
        output
            .write_all(&length.to_be_bytes())
            .map_err(|_| ReadError::ReadFailed)?;
        output
            .write_all(&contents)
            .map_err(|_| ReadError::ReadFailed)?;
    }
    Ok(())
}

pub fn read_bounded_file(request: &ReadRequest) -> Result<Vec<u8>, ReadError> {
    if request.max_bytes > MAX_FILE_BYTES {
        return Err(ReadError::OutputLimit);
    }
    with_file(&request.root, &request.path, false, |file| {
        if file.metadata().map_err(|_| ReadError::ReadFailed)?.len() > request.max_bytes {
            return Err(ReadError::OutputLimit);
        }
        let mut bytes = Vec::new();
        file.take(request.max_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ReadError::ReadFailed)?;
        if bytes.len() as u64 > request.max_bytes {
            return Err(ReadError::OutputLimit);
        }
        Ok(bytes)
    })
}

fn with_file<T>(
    root: &str,
    path: &str,
    exact_path: bool,
    operation: impl FnOnce(&mut File) -> Result<T, ReadError>,
) -> Result<T, ReadError> {
    #[cfg(windows)]
    return windows::with_file(root, path, exact_path, operation);
    #[cfg(target_os = "linux")]
    return linux::with_file(root, path, exact_path, operation);
    #[cfg(target_os = "macos")]
    return macos::with_file(root, path, exact_path, operation);
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    Err(ReadError::Unavailable)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StreamRequest {
    root: String,
    path: String,
    start: u64,
    length: u64,
    size_bytes: u64,
    file_id: String,
}

fn stream_file_id(file: &File) -> Result<String, ReadError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata().map_err(|_| ReadError::ReadFailed)?;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        let (volume, high, low) =
            crate::windows_fs::identity(file).map_err(|_| ReadError::ReadFailed)?;
        let index = (u64::from(high) << 32) | u64::from(low);
        Ok(format!("{volume}:{index}"))
    }
    #[cfg(not(any(unix, windows)))]
    Err(ReadError::Unavailable)
}

pub fn run_stream(mut input: impl BufRead, mut output: impl Write) -> Result<(), ReadError> {
    let mut bytes = Vec::new();
    (&mut input)
        .take(MAX_REQUEST_BYTES + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| ReadError::ReadFailed)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES || bytes.last() != Some(&b'\n') {
        return Err(ReadError::ReadFailed);
    }
    let request: StreamRequest =
        serde_json::from_slice(&bytes).map_err(|_| ReadError::ReadFailed)?;
    let end = request
        .start
        .checked_add(request.length)
        .ok_or(ReadError::OutputLimit)?;
    if end > request.size_bytes || request.size_bytes > 9_007_199_254_740_991 {
        return Err(ReadError::OutputLimit);
    }
    with_file(&request.root, &request.path, true, |file| {
        if stream_file_id(file)? != request.file_id
            || file.metadata().map_err(|_| ReadError::ReadFailed)?.len() != request.size_bytes
        {
            return Err(ReadError::ReadFailed);
        }
        file.seek(SeekFrom::Start(request.start))
            .map_err(|_| ReadError::ReadFailed)?;
        output
            .write_all(&[1])
            .and_then(|()| output.flush())
            .map_err(|_| ReadError::ReadFailed)?;
        let mut ready = [0u8; 1];
        input
            .read_exact(&mut ready)
            .map_err(|_| ReadError::ReadFailed)?;
        if ready != [1] {
            return Err(ReadError::ReadFailed);
        }
        let copied = std::io::copy(&mut file.take(request.length), &mut output)
            .map_err(|_| ReadError::ReadFailed)?;
        if copied != request.length {
            return Err(ReadError::ReadFailed);
        }
        output.flush().map_err(|_| ReadError::ReadFailed)
    })
}
