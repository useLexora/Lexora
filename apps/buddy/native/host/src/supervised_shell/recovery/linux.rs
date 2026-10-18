use std::{fs, io};

use super::{Identity, Verification, query_error, valid_uuid};

pub(super) const PLATFORM: &str = "linux";

pub(super) fn boot_id() -> io::Result<String> {
    let value = fs::read_to_string("/proc/sys/kernel/random/boot_id")?
        .trim()
        .to_owned();
    if !valid_uuid(&value) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(value)
}

pub(super) fn verify(identity: &Identity) -> Verification {
    if identity.job_name.is_some() {
        return Verification::unknown("identity_invalid");
    }
    let Some(pid) = identity.pid else {
        return Verification::unknown("identity_incomplete");
    };
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => {
            let Some(start) = stat
                .rsplit_once(')')
                .and_then(|(_, fields)| fields.split_whitespace().nth(19))
            else {
                return Verification::unknown("query_failed");
            };
            if Some(start) == identity.start_time.as_deref() {
                Verification::new("active", "supervisor_active")
            } else {
                Verification::unknown("descendants_unverified")
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Verification::unknown("descendants_unverified")
        }
        Err(error) => query_error(&error),
    }
}
