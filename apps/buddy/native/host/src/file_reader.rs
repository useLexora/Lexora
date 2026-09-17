use std::io::{Read, Write};

use serde::Deserialize;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES: u64 = 256 * 1024;

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

pub fn read_bounded_file(request: &ReadRequest) -> Result<Vec<u8>, ReadError> {
    if request.max_bytes > MAX_FILE_BYTES {
        return Err(ReadError::OutputLimit);
    }
    #[cfg(windows)]
    return windows::read(request);
    #[cfg(target_os = "linux")]
    return linux::read(request);
    #[cfg(target_os = "macos")]
    return macos::read(request);
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    Err(ReadError::Unavailable)
}
