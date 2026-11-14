use std::{
    io::{self, Write},
    mem::MaybeUninit,
    num::NonZeroU32,
};

use serde::Serialize;

use super::{ProcessError, Request, Selector};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    pid: u32,
    executable: String,
    instance_id: String,
}

pub(super) fn request(request: &Request, output: impl Write) -> Result<(), ProcessError> {
    let pid = match request {
        Request::Read { pid, .. }
        | Request::Resolve {
            selector: Selector::Pid { pid },
            ..
        } => *pid,
        _ => return Err(ProcessError::Unavailable),
    };
    let identity = read_identity(pid)?;
    serde_json::to_writer(output, identity.as_slice()).map_err(|_| ProcessError::Failed)
}

fn read_identity(pid: NonZeroU32) -> Result<Option<Identity>, ProcessError> {
    let Some(first) = read_info(pid)? else {
        return Ok(None);
    };
    let mut path = [0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: The writable buffer has the exact supplied capacity and the PID fits libc's type.
    let length = unsafe {
        libc::proc_pidpath(
            pid.get() as i32,
            path.as_mut_ptr().cast(),
            path.len() as u32,
        )
    };
    if length <= 0 {
        return if io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            Ok(None)
        } else {
            Err(ProcessError::Failed)
        };
    }
    let length = usize::try_from(length).map_err(|_| ProcessError::Failed)?;
    if length >= path.len() {
        return Err(ProcessError::Failed);
    }
    let executable = std::str::from_utf8(&path[..length])
        .map_err(|_| ProcessError::Failed)?
        .trim_end_matches('\0')
        .to_owned();
    let Some(second) = read_info(pid)? else {
        return Ok(None);
    };
    if first.pbi_start_tvsec != second.pbi_start_tvsec
        || first.pbi_start_tvusec != second.pbi_start_tvusec
        || first.pbi_uid != second.pbi_uid
        || !std::path::Path::new(&executable).is_absolute()
    {
        return Err(ProcessError::TargetChanged);
    }
    let started = first
        .pbi_start_tvsec
        .checked_mul(1_000_000)
        .and_then(|seconds| seconds.checked_add(first.pbi_start_tvusec))
        .ok_or(ProcessError::Failed)?;
    Ok(Some(Identity {
        pid: pid.get(),
        executable,
        instance_id: started.to_string(),
    }))
}

fn read_info(pid: NonZeroU32) -> Result<Option<libc::proc_bsdinfo>, ProcessError> {
    let pid = i32::try_from(pid.get()).map_err(|_| ProcessError::Invalid)?;
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
    // SAFETY: proc_pidinfo writes at most the supplied size to an aligned, owned output buffer.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if written != size_of::<libc::proc_bsdinfo>() as i32 {
        return if written == 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            Ok(None)
        } else {
            Err(ProcessError::Failed)
        };
    }
    // SAFETY: The kernel returned the entire initialized proc_bsdinfo structure above.
    let info = unsafe { info.assume_init() };
    // SAFETY: geteuid has no pointer arguments and only reads the calling process identity.
    let uid = unsafe { libc::geteuid() };
    if info.pbi_status == libc::SZOMB {
        return Ok(None);
    }
    if info.pbi_pid != pid as u32
        || info.pbi_start_tvsec == 0
        || info.pbi_start_tvusec >= 1_000_000
        || info.pbi_uid != uid
    {
        return Err(ProcessError::TargetChanged);
    }
    Ok(Some(info))
}
