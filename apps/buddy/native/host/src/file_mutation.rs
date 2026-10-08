//! Small, fail-closed Windows entry mutations. No shell commands or permanent-delete fallback.
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Read, Write};

#[cfg(windows)]
mod windows;

#[derive(Debug, thiserror::Error)]
pub enum MutationError {
    #[error("invalid-name")]
    InvalidName,
    #[error("exists")]
    Exists,
    #[error("missing")]
    Missing,
    #[error("unsafe-path")]
    UnsafePath,
    #[error("permission")]
    Permission,
    #[error("busy")]
    Busy,
    #[error("unsupported")]
    Unsupported,
    #[error("case-only")]
    CaseOnly,
    #[error("failed")]
    Failed,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    CreateFile,
    CreateDirectory,
    Rename,
    Trash,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationRequest {
    pub root: String,
    pub path: String,
    pub operation: Operation,
    pub name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
}

#[cfg_attr(not(windows), allow(unused_mut))]
pub fn run(mut input: impl BufRead, mut output: impl Write) -> Result<(), MutationError> {
    let mut request = String::new();
    Read::take(input.by_ref(), 65537)
        .read_line(&mut request)
        .map_err(|_| MutationError::Failed)?;
    if request.len() > 65536 {
        return Err(MutationError::Failed);
    }
    let request: MutationRequest =
        serde_json::from_str(&request).map_err(|_| MutationError::Failed)?;
    #[cfg(windows)]
    {
        let prepared = windows::prepare(request)?;
        // Ancestors and source stay pinned while the service rechecks the live grant.
        writeln!(output, "ready").map_err(|_| MutationError::Failed)?;
        output.flush().map_err(|_| MutationError::Failed)?;
        let mut decision = String::new();
        Read::take(input.by_ref(), 16)
            .read_line(&mut decision)
            .map_err(|_| MutationError::Failed)?;
        if decision != "commit\n" {
            return Err(MutationError::Failed);
        }
        let kind = prepared.commit()?;
        serde_json::to_writer(&mut output, &kind).map_err(|_| MutationError::Failed)?;
        output.flush().map_err(|_| MutationError::Failed)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (request, output);
        Err(MutationError::Unsupported)
    }
}
