use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

#[cfg(target_os = "linux")]
#[path = "recovery/linux.rs"]
mod backend;
#[cfg(windows)]
#[path = "recovery/windows.rs"]
pub(crate) mod backend;
#[cfg(any(windows, test))]
#[path = "recovery/windows_boot.rs"]
pub(crate) mod windows_boot;

const MAX_INPUT_BYTES: u64 = 8192;
pub(crate) const WINDOWS_JOB_PREFIX: &str = r"Global\Lexora.Buddy.Shell.v2.";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Identity {
    kind: String,
    platform: String,
    pid: Option<u32>,
    start_time: Option<String>,
    nonce: Option<String>,
    version: Option<u32>,
    boot_id: Option<String>,
    job_name: Option<String>,
    execution_id: Option<String>,
    dispatch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    boot_evidence: Option<serde_json::Value>,
    #[serde(rename = "requestId")]
    _request_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LegacyCheckpoint {
    kind: String,
    version: u32,
    platform: String,
    boot_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub(super) enum Checkpoint {
    Legacy(LegacyCheckpoint),
    Windows(WindowsCheckpoint),
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WindowsCheckpoint {
    kind: String,
    version: u32,
    platform: String,
    boot_evidence: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    identity: Identity,
    checkpoint: Option<Checkpoint>,
    receipt_directory: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Verification {
    protocol: u32,
    status: &'static str,
    reason: &'static str,
}

impl Verification {
    fn new(status: &'static str, reason: &'static str) -> Self {
        Self {
            protocol: 1,
            status,
            reason,
        }
    }

    fn unknown(reason: &'static str) -> Self {
        Self::new("unknown", reason)
    }
}

pub fn checkpoint(mut output: impl Write) -> io::Result<()> {
    #[cfg(windows)]
    {
        let result = windows_boot::capture().map(|boot| WindowsCheckpoint {
            kind: "recovery-boot".into(),
            version: 2,
            platform: backend::PLATFORM.into(),
            boot_evidence: serde_json::to_value(boot).unwrap_or_default(),
        });
        match result {
            Ok(checkpoint) => serde_json::to_writer(&mut output, &checkpoint)?,
            Err(_) => {
                serde_json::to_writer(&mut output, &Verification::unknown("boot_id_unavailable"))?
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let result = backend::boot_id().map(|boot_id| LegacyCheckpoint {
            kind: "recovery-boot".into(),
            version: 1,
            platform: backend::PLATFORM.into(),
            boot_id,
        });
        match result {
            Ok(checkpoint) => serde_json::to_writer(&mut output, &checkpoint)?,
            Err(_) => {
                serde_json::to_writer(&mut output, &Verification::unknown("boot_id_unavailable"))?
            }
        }
        Ok(())
    }
}

pub fn reverify(input: impl Read, mut output: impl Write) -> io::Result<()> {
    let mut bytes = Vec::new();
    input.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes)?;
    let verification = if bytes.len() as u64 > MAX_INPUT_BYTES {
        Verification::unknown("identity_invalid")
    } else {
        serde_json::from_slice::<Request>(&bytes)
            .map(verify)
            .unwrap_or_else(|_| Verification::unknown("identity_invalid"))
    };
    serde_json::to_writer(&mut output, &verification)?;
    Ok(())
}

fn verify(mut request: Request) -> Verification {
    if request.identity.version == Some(3) {
        let identity = &request.identity;
        if identity.platform != backend::PLATFORM {
            return Verification::unknown("platform_mismatch");
        }
        if !matches!(
            identity.kind.as_str(),
            "native-shell" | "sandbox-job" | "native-shell-dispatch" | "sandbox-dispatch"
        ) {
            return Verification::unknown("unsupported_process");
        }
        let (Some(execution_id), Some(dispatch_id)) =
            (&identity.execution_id, &identity.dispatch_id)
        else {
            return Verification::unknown("identity_incomplete");
        };
        if !valid_uuid(execution_id) || !valid_uuid(dispatch_id) {
            return Verification::unknown("identity_invalid");
        }
        if let Some(root) = &request.receipt_directory {
            match super::receipt::recover(root, execution_id, dispatch_id) {
                Ok((mut prepared, released)) => {
                    let dispatch = matches!(
                        identity.kind.as_str(),
                        "native-shell-dispatch" | "sandbox-dispatch"
                    );
                    if !dispatch
                        && (prepared["pid"].as_u64() != identity.pid.map(u64::from)
                            || prepared["startTime"].as_str() != identity.start_time.as_deref()
                            || prepared["jobName"].as_str() != identity.job_name.as_deref()
                            || prepared["bootId"].as_str() != identity.boot_id.as_deref()
                            || prepared.get("bootEvidence") != identity.boot_evidence.as_ref())
                    {
                        return Verification::unknown("receipt_invalid");
                    }
                    prepared["kind"] = serde_json::json!(if identity.platform == "win32"
                        && identity.kind == "sandbox-job"
                    {
                        "sandbox-job"
                    } else {
                        "native-shell"
                    });
                    prepared["platform"] = serde_json::json!(identity.platform);
                    let owner: Identity = match serde_json::from_value(prepared) {
                        Ok(identity) => identity,
                        Err(_) => return Verification::unknown("receipt_invalid"),
                    };
                    if !valid_receipt_owner(&owner) {
                        return Verification::unknown("receipt_invalid");
                    }
                    if released {
                        return Verification::new("released", "supervisor_receipt");
                    }
                    request.identity = owner;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    return Verification::unknown("receipt_missing");
                }
                Err(_) => return Verification::unknown("receipt_invalid"),
            }
        } else if matches!(
            identity.kind.as_str(),
            "native-shell-dispatch" | "sandbox-dispatch"
        ) {
            return Verification::unknown("receipt_root_unavailable");
        }
    }
    let identity = &request.identity;
    if !matches!(identity.kind.as_str(), "native-shell" | "sandbox-job")
        || (identity.kind == "sandbox-job" && identity.platform != "win32")
    {
        return Verification::unknown("unsupported_process");
    }
    if identity.platform != backend::PLATFORM {
        return Verification::unknown("platform_mismatch");
    }
    if identity.pid.is_none_or(|pid| pid == 0)
        || identity.start_time.as_deref().is_none_or(|value| {
            value.is_empty()
                || !value.bytes().all(|byte| byte.is_ascii_digit())
                || value.parse::<u64>().is_err()
        })
        || (identity.version != Some(3) && identity.nonce.as_deref().is_none_or(str::is_empty))
    {
        return Verification::unknown("identity_incomplete");
    }
    if identity
        .version
        .is_some_and(|version| version != 2 && version != 3)
    {
        return Verification::unknown("identity_version_unsupported");
    }
    if identity
        .boot_id
        .as_deref()
        .is_some_and(|value| !valid_uuid(value))
        || (identity.version == Some(2)
            && identity.platform != "win32"
            && identity.boot_id.is_none())
    {
        return Verification::unknown("identity_invalid");
    }
    if identity.platform == "linux" && identity.job_name.is_some() {
        return Verification::unknown("identity_invalid");
    }
    if identity.platform == "win32"
        && identity.version == Some(2)
        && identity.job_name.as_deref().is_none_or(|name| {
            !name
                .strip_prefix(WINDOWS_JOB_PREFIX)
                .is_some_and(valid_uuid)
        })
    {
        return Verification::unknown("identity_incomplete");
    }
    #[cfg(windows)]
    {
        verify_windows_boot(identity, request.checkpoint)
    }
    #[cfg(not(windows))]
    {
        let current_boot = match backend::boot_id() {
            Ok(boot) => boot,
            Err(_) => return Verification::unknown("boot_id_unavailable"),
        };
        if identity
            .boot_id
            .as_ref()
            .is_some_and(|boot| *boot != current_boot)
        {
            return Verification::new("released", "boot_changed");
        }
        if let Some(checkpoint) = request.checkpoint {
            let Checkpoint::Legacy(checkpoint) = checkpoint else {
                return Verification::unknown("checkpoint_invalid");
            };
            if checkpoint.kind != "recovery-boot"
                || checkpoint.version != 1
                || checkpoint.platform != identity.platform
                || !valid_uuid(&checkpoint.boot_id)
            {
                return Verification::unknown("checkpoint_invalid");
            }
            if checkpoint.boot_id != current_boot {
                return Verification::new("released", "boot_changed");
            }
        }
        backend::verify(identity)
    }
}

fn valid_receipt_owner(identity: &Identity) -> bool {
    if identity.version != Some(3)
        || identity.platform != backend::PLATFORM
        || identity.pid.is_none_or(|pid| pid == 0)
        || identity.start_time.as_deref().is_none_or(|value| {
            value.is_empty()
                || !value.bytes().all(|byte| byte.is_ascii_digit())
                || value.parse::<u64>().is_err()
        })
        || identity
            .execution_id
            .as_deref()
            .is_none_or(|value| !valid_uuid(value))
        || identity
            .dispatch_id
            .as_deref()
            .is_none_or(|value| !valid_uuid(value))
        || identity
            .boot_id
            .as_deref()
            .is_some_and(|value| !valid_uuid(value))
    {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        identity.boot_id.is_some()
            && identity.job_name.is_none()
            && identity.boot_evidence.is_none()
    }
    #[cfg(windows)]
    {
        identity.job_name.as_deref().is_some_and(|name| {
            name.strip_prefix(WINDOWS_JOB_PREFIX)
                .is_some_and(valid_uuid)
        }) && identity.boot_evidence.as_ref().is_none_or(|value| {
            serde_json::from_value::<windows_boot::Evidence>(value.clone())
                .is_ok_and(|evidence| evidence.valid())
        })
    }
}

#[cfg(windows)]
fn verify_windows_boot(identity: &Identity, checkpoint: Option<Checkpoint>) -> Verification {
    let saved = match checkpoint {
        Some(Checkpoint::Windows(checkpoint)) => {
            if checkpoint.kind != "recovery-boot"
                || checkpoint.version != 2
                || checkpoint.platform != "win32"
            {
                return Verification::unknown("checkpoint_invalid");
            }
            Some(checkpoint.boot_evidence)
        }
        Some(Checkpoint::Legacy(checkpoint)) => {
            if checkpoint.kind != "recovery-boot"
                || checkpoint.version != 1
                || checkpoint.platform != "win32"
                || !valid_uuid(&checkpoint.boot_id)
            {
                return Verification::unknown("checkpoint_invalid");
            }
            None
        }
        None => None,
    };
    let previous = saved.as_ref().or(identity.boot_evidence.as_ref());
    if let Some(previous) = previous {
        let previous: windows_boot::Evidence =
            match serde_json::from_value::<windows_boot::Evidence>(previous.clone()) {
                Ok(evidence) if evidence.valid() => evidence,
                _ => return Verification::unknown("checkpoint_invalid"),
            };
        if windows_boot::capture().is_ok_and(|current| current.proves_restart_from(&previous)) {
            return Verification::new("released", "boot_changed");
        }
    }
    backend::verify(identity)
}

pub(super) fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == value)
}

fn query_error(error: &io::Error) -> Verification {
    Verification::unknown(if error.kind() == io::ErrorKind::PermissionDenied {
        "access_denied"
    } else {
        "query_failed"
    })
}

#[cfg(test)]
#[path = "../../__tests__/process_recovery.rs"]
mod tests;
