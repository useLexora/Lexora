use std::io::{Read, Write};

use serde::{Deserialize, Serialize};

#[cfg(windows)]
mod windows;

const MAX_REQUEST_BYTES: u64 = 256 * 1024;

#[derive(Debug, PartialEq, Serialize, thiserror::Error)]
pub enum DirectoryError {
    #[error("PRIVATE_DIRECTORIES_INVALID")]
    #[serde(rename = "PRIVATE_DIRECTORIES_INVALID")]
    Invalid,
    #[error("PRIVATE_DIRECTORIES_UNSAFE")]
    #[serde(rename = "PRIVATE_DIRECTORIES_UNSAFE")]
    Unsafe,
    #[error("PRIVATE_DIRECTORIES_FAILED")]
    #[serde(rename = "PRIVATE_DIRECTORIES_FAILED")]
    Failed,
    #[error("PRIVATE_DIRECTORIES_UNAVAILABLE")]
    #[serde(rename = "PRIVATE_DIRECTORIES_UNAVAILABLE")]
    Unavailable,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryOperation {
    Request,
    Identity,
    OpenRoot,
    OpenDirectory,
    InspectDirectory,
    ValidateAcl,
    Response,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemErrorDomain {
    Win32,
    Ntstatus,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct SystemError {
    domain: SystemErrorDomain,
    code: u32,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryAclReason {
    OwnerMissing,
    OwnerUntrusted,
    DaclMissing,
    NullDacl,
    AclInvalid,
    AceInvalid,
    UntrustedAccess,
    UnsupportedAce,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryPrincipal {
    CurrentUser,
    System,
    Administrators,
    CreatorOwner,
    Everyone,
    BuiltinUsers,
    AuthenticatedUsers,
    AllAppPackages,
    Other,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryAclFailure {
    reason: DirectoryAclReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    ace_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ace_type: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ace_flags: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    access_mask: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    principal: Option<DirectoryPrincipal>,
}

#[cfg(windows)]
impl DirectoryAclFailure {
    fn new(reason: DirectoryAclReason) -> Self {
        Self {
            reason,
            ace_index: None,
            ace_type: None,
            ace_flags: None,
            access_mask: None,
            principal: None,
        }
    }
}

#[derive(Debug, PartialEq, Serialize, thiserror::Error)]
#[error("{code}")]
#[serde(rename_all = "camelCase")]
pub struct DirectoryFailure {
    code: DirectoryError,
    operation: DirectoryOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    directory_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_error: Option<SystemError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    acl: Option<DirectoryAclFailure>,
}

impl DirectoryFailure {
    fn new(code: DirectoryError, operation: DirectoryOperation) -> Self {
        Self {
            code,
            operation,
            directory_index: None,
            system_error: None,
            acl: None,
        }
    }

    #[cfg(windows)]
    fn acl(details: DirectoryAclFailure) -> Self {
        Self {
            acl: Some(details),
            ..Self::new(DirectoryError::Unsafe, DirectoryOperation::ValidateAcl)
        }
    }

    #[cfg(windows)]
    fn io(operation: DirectoryOperation, error: std::io::Error) -> Self {
        let mut failure = Self::new(DirectoryError::Failed, operation);
        failure.system_error = error.raw_os_error().map(|code| SystemError {
            domain: SystemErrorDomain::Win32,
            code: code as u32,
        });
        failure
    }

    #[cfg(windows)]
    fn system(operation: DirectoryOperation, domain: SystemErrorDomain, code: u32) -> Self {
        Self {
            system_error: Some(SystemError { domain, code }),
            ..Self::new(DirectoryError::Failed, operation)
        }
    }

    #[cfg(windows)]
    fn at_directory(mut self, index: usize) -> Self {
        self.directory_index = Some(index);
        self
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    paths: Vec<String>,
}

fn read_request(input: impl Read) -> Result<Request, DirectoryError> {
    let mut bytes = Vec::new();
    input
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| DirectoryError::Invalid)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(DirectoryError::Invalid);
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| DirectoryError::Invalid)?;
    if request.paths.is_empty() || request.paths.len() > 64 {
        return Err(DirectoryError::Invalid);
    }
    for path in &request.paths {
        directory_parts(path)?;
    }
    Ok(request)
}

fn directory_parts(path: &str) -> Result<(String, Vec<&str>), DirectoryError> {
    if !crate::windows_path::valid(path) {
        return Err(DirectoryError::Invalid);
    }
    let (root, rest) = if let Some(unc) = path.strip_prefix("\\\\") {
        let mut parts = unc.splitn(3, '\\');
        let server = parts.next().ok_or(DirectoryError::Invalid)?;
        let share = parts.next().ok_or(DirectoryError::Invalid)?;
        (
            format!("\\\\?\\UNC\\{server}\\{share}\\"),
            parts.next().unwrap_or_default(),
        )
    } else {
        (format!("\\\\?\\{}", &path[..3]), &path[3..])
    };
    let parts: Vec<_> = rest.trim_end_matches('\\').split('\\').collect();
    if parts.len() > 256
        || parts
            .iter()
            .any(|part| part.is_empty() || part.encode_utf16().count() > 255)
    {
        return Err(DirectoryError::Invalid);
    }
    Ok((root, parts))
}

pub fn run(input: impl Read, output: impl Write) -> Result<(), DirectoryFailure> {
    let request = read_request(input)
        .map_err(|code| DirectoryFailure::new(code, DirectoryOperation::Request))?;
    #[cfg(windows)]
    {
        windows::ensure(&request.paths, windows::ExistingDirectoryPolicy::Preserve)?;
        let mut output = output;
        output.write_all(b"{\"ok\":true}").map_err(|_| {
            DirectoryFailure::new(DirectoryError::Failed, DirectoryOperation::Response)
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (request, output);
        Err(DirectoryFailure::new(
            DirectoryError::Unavailable,
            DirectoryOperation::Identity,
        ))
    }
}

#[cfg(windows)]
pub(crate) fn ensure(paths: &[String]) -> Result<(), DirectoryFailure> {
    windows::ensure(paths, windows::ExistingDirectoryPolicy::ValidateAcl)
}

#[cfg(test)]
#[path = "../__tests__/private_directories.rs"]
mod tests;
