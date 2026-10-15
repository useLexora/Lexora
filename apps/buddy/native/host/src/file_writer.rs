use std::io::Read;

use serde::Deserialize;

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_ENGINE_TEXT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error("BOUNDED_FILE_WRITE_FAILED")]
    Failed,
    #[error("BOUNDED_FILE_CONFLICT")]
    Conflict,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteRequest {
    pub root: String,
    pub path: String,
    pub expected: String,
    pub content: String,
}

pub fn run(input: impl Read) -> Result<(), WriteError> {
    let mut bytes = Vec::new();
    input
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| WriteError::Failed)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(WriteError::Failed);
    }
    let request: WriteRequest = serde_json::from_slice(&bytes).map_err(|_| WriteError::Failed)?;
    if request.expected.len() > 1024 * 1024 || request.content.len() > 1024 * 1024 {
        return Err(WriteError::Failed);
    }
    write(&request)
}

pub fn write(request: &WriteRequest) -> Result<(), WriteError> {
    if request.expected.len() > MAX_TEXT_BYTES || request.content.len() > MAX_TEXT_BYTES {
        return Err(WriteError::Failed);
    }
    write_large(request)
}

pub fn write_large(request: &WriteRequest) -> Result<(), WriteError> {
    if request.expected.len() > MAX_ENGINE_TEXT_BYTES
        || request.content.len() > MAX_ENGINE_TEXT_BYTES
    {
        return Err(WriteError::Failed);
    }
    #[cfg(unix)]
    return unix::write(request);
    #[cfg(windows)]
    return windows::write(request);
    #[cfg(not(any(unix, windows)))]
    Err(WriteError::Failed)
}

fn check_content(file: &std::fs::File, expected: &str) -> Result<(), WriteError> {
    let metadata = file.metadata().map_err(|_| WriteError::Failed)?;
    if !metadata.is_file() || metadata.len() > MAX_ENGINE_TEXT_BYTES as u64 {
        return Err(WriteError::Failed);
    }
    let mut bytes = Vec::new();
    file.take(MAX_ENGINE_TEXT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| WriteError::Failed)?;
    if bytes != expected.as_bytes() {
        return Err(WriteError::Conflict);
    }
    Ok(())
}
