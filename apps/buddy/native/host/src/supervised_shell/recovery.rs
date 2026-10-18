use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

#[cfg(target_os = "linux")]
#[path = "recovery/linux.rs"]
mod backend;
#[cfg(windows)]
#[path = "recovery/windows.rs"]
pub(crate) mod backend;

const MAX_INPUT_BYTES: u64 = 8192;
pub(crate) const WINDOWS_JOB_PREFIX: &str = r"Global\Lexora.Buddy.Shell.v2.";

#[derive(Deserialize)]
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
    #[serde(rename = "requestId")]
    _request_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Checkpoint {
    kind: String,
    version: u32,
    platform: String,
    boot_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    identity: Identity,
    checkpoint: Option<Checkpoint>,
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
    let result = backend::boot_id().map(|boot_id| Checkpoint {
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

fn verify(request: Request) -> Verification {
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
        || identity.nonce.as_deref().is_none_or(str::is_empty)
    {
        return Verification::unknown("identity_incomplete");
    }
    if identity.version.is_some_and(|version| version != 2) {
        return Verification::unknown("identity_version_unsupported");
    }
    if identity
        .boot_id
        .as_deref()
        .is_some_and(|value| !valid_uuid(value))
        || (identity.version == Some(2) && identity.boot_id.is_none())
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

fn valid_uuid(value: &str) -> bool {
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
