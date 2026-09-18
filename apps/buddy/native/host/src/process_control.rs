use std::{
    io::{Read, Write},
    num::NonZeroU32,
};

use serde::{Deserialize, Serialize};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(windows, target_os = "linux", test))]
mod policy;
#[cfg(windows)]
mod windows;

const MAX_REQUEST_BYTES: u64 = 64 * 1024;
#[cfg(any(windows, target_os = "linux"))]
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ProcessError {
    #[error("SYSTEM_ACTION_INVALID")]
    Invalid,
    #[error("SYSTEM_ACTION_NOT_ALLOWED")]
    NotAllowed,
    #[error("SYSTEM_TARGET_CHANGED")]
    TargetChanged,
    #[error("SYSTEM_OPERATION_FAILED")]
    Failed,
    #[error("SYSTEM_HOST_UNAVAILABLE")]
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
enum Action {
    #[serde(rename = "terminate-process")]
    Terminate,
    #[serde(rename = "kill-process")]
    Kill,
}

#[derive(Debug, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
#[cfg_attr(
    not(any(windows, target_os = "linux")),
    expect(dead_code, reason = "Process lookup requires a supported host")
)]
enum Selector {
    Pid { pid: NonZeroU32 },
    Name { name: String },
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(
    not(any(windows, target_os = "linux")),
    expect(dead_code, reason = "Process execution requires a supported host")
)]
enum Request {
    Resolve {
        selector: Selector,
        protected_pids: Vec<NonZeroU32>,
    },
    Read {
        pid: NonZeroU32,
        protected_pids: Vec<NonZeroU32>,
    },
    Execute {
        pid: NonZeroU32,
        instance_id: String,
        executable: String,
        action: Action,
        protected_pids: Vec<NonZeroU32>,
    },
}

impl Request {
    fn protected_pids(&self) -> &[NonZeroU32] {
        match self {
            Self::Resolve { protected_pids, .. }
            | Self::Read { protected_pids, .. }
            | Self::Execute { protected_pids, .. } => protected_pids,
        }
    }
}

fn process_name(name: &str) -> &str {
    match name.get(name.len().saturating_sub(4)..) {
        Some(suffix) if suffix.eq_ignore_ascii_case(".exe") => &name[..name.len() - 4],
        _ => name,
    }
}

fn read_request(input: impl Read) -> Result<Request, ProcessError> {
    let mut bytes = Vec::new();
    input
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ProcessError::Invalid)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(ProcessError::Invalid);
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| ProcessError::Invalid)?;
    if request.protected_pids().len() > 64 {
        return Err(ProcessError::Invalid);
    }
    match &request {
        Request::Resolve {
            selector: Selector::Name { name },
            ..
        } if process_name(name).trim().is_empty()
            || name.encode_utf16().count() > 256
            || name
                .chars()
                .any(|c| c < ' ' || matches!(c, '/' | '\\' | ':' | '*' | '?' | '[' | ']')) =>
        {
            return Err(ProcessError::Invalid);
        }
        Request::Execute {
            instance_id,
            executable,
            ..
        } if instance_id.parse::<u64>().is_err()
            || !instance_id.bytes().all(|c| c.is_ascii_digit())
            || executable.is_empty()
            || executable.encode_utf16().count() > 32767
            || executable.chars().any(|c| c < ' ') =>
        {
            return Err(ProcessError::Invalid);
        }
        _ => {}
    }
    Ok(request)
}

pub fn run(input: impl Read, output: impl Write) -> Result<(), ProcessError> {
    let request = read_request(input)?;
    #[cfg(windows)]
    {
        let bytes = windows::request(&request)?;
        let mut output = output;
        output.write_all(&bytes).map_err(|_| ProcessError::Failed)
    }
    #[cfg(target_os = "linux")]
    {
        let bytes = linux::request(&request)?;
        let mut output = output;
        output.write_all(&bytes).map_err(|_| ProcessError::Failed)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (request, output);
        Err(ProcessError::Unavailable)
    }
}

#[cfg(windows)]
pub fn executable_running(executable: &str) -> Result<bool, ProcessError> {
    if !crate::windows_path::valid(executable)
        || !std::path::Path::new(executable)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return Err(ProcessError::Invalid);
    }
    windows::executable_running(executable)
}

#[cfg(test)]
#[path = "../__tests__/process_control.rs"]
mod tests;
