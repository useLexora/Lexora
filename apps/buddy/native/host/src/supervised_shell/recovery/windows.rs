use std::{io, os::windows::io::AsRawHandle, ptr};

use windows_sys::Win32::{
    Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    },
    System::{JobObjects::*, SystemServices::JOB_OBJECT_QUERY, Threading::*},
};

use super::{Identity, Verification, WINDOWS_JOB_PREFIX, query_error, valid_uuid};
use crate::supervised_shell::windows::{boolean, owned, wide};

pub(super) const PLATFORM: &str = "win32";

#[repr(C)]
#[derive(Default)]
struct BootEnvironment {
    identifier: windows_sys::core::GUID,
    firmware_type: u32,
    flags: u64,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQuerySystemInformation(
        class: u32,
        information: *mut std::ffi::c_void,
        length: u32,
        returned: *mut u32,
    ) -> i32;
}

pub(crate) fn boot_id() -> io::Result<String> {
    let mut information = BootEnvironment::default();
    let mut returned = 0;
    // SAFETY: SystemBootEnvironmentInformation (90) writes this fixed, correctly aligned native structure.
    let status = unsafe {
        NtQuerySystemInformation(
            90,
            ptr::from_mut(&mut information).cast(),
            size_of::<BootEnvironment>() as u32,
            &mut returned,
        )
    };
    if status < 0 || returned != size_of::<BootEnvironment>() as u32 {
        return Err(io::ErrorKind::Unsupported.into());
    }
    let guid = information.identifier;
    let id = uuid::Uuid::from_fields(guid.data1, guid.data2, guid.data3, &guid.data4);
    if id.is_nil() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(id.hyphenated().to_string())
}

pub(crate) fn start_time(process: HANDLE) -> io::Result<u64> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: The caller holds a queryable process handle; all FILETIME outputs are writable.
    boolean(unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) })?;
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

pub(super) fn verify(identity: &Identity) -> Verification {
    let Some(pid) = identity.pid else {
        return Verification::unknown("identity_incomplete");
    };
    let Some(expected_start) = identity
        .start_time
        .as_deref()
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return Verification::unknown("identity_invalid");
    };
    let supervisor_active = match supervisor_active(pid, expected_start) {
        Ok(active) => active,
        Err(error) => return query_error(&error),
    };
    if supervisor_active {
        return Verification::new("active", "supervisor_active");
    }
    if identity.version != Some(2) {
        return Verification::unknown("legacy_identity");
    }
    let Some(name) = identity.job_name.as_deref().filter(|name| {
        name.strip_prefix(WINDOWS_JOB_PREFIX)
            .is_some_and(valid_uuid)
    }) else {
        return Verification::unknown("identity_incomplete");
    };
    // SAFETY: Only the fixed product namespace is accepted; this non-inheritable handle has query rights only.
    let handle = unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, wide(name).as_ptr()) };
    let job = match owned(handle) {
        Ok(job) => job,
        Err(error) if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => {
            // Name disappearance alone does not prove asynchronous kill-on-close has finished.
            return Verification::unknown("job_not_found");
        }
        Err(error) => return query_error(&error),
    };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    // SAFETY: The query-only job is live and the buffer matches the information class.
    if let Err(error) = boolean(unsafe {
        QueryInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            ptr::from_mut(&mut limits).cast(),
            size_of_val(&limits) as u32,
            ptr::null_mut(),
        )
    }) {
        return query_error(&error);
    }
    let flags = limits.BasicLimitInformation.LimitFlags;
    if flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0
        || flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) != 0
    {
        return Verification::unknown("job_boundary_unverified");
    }
    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    // SAFETY: The query-only job is live and the buffer matches the information class.
    if let Err(error) = boolean(unsafe {
        QueryInformationJobObject(
            job.as_raw_handle(),
            JobObjectBasicAccountingInformation,
            ptr::from_mut(&mut accounting).cast(),
            size_of_val(&accounting) as u32,
            ptr::null_mut(),
        )
    }) {
        return query_error(&error);
    }
    if accounting.ActiveProcesses == 0 {
        Verification::new("released", "job_empty")
    } else {
        Verification::new("active", "job_active")
    }
}

fn supervisor_active(pid: u32, expected_start: u64) -> io::Result<bool> {
    // SAFETY: Opening by PID grants only identity queries and a zero-time wait, never process mutation.
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    let process = match owned(handle) {
        Ok(process) => process,
        Err(error) if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => {
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    if start_time(process.as_raw_handle())? != expected_start {
        return Ok(false);
    }
    // SAFETY: This is a live process handle opened with SYNCHRONIZE; the wait is nonblocking.
    match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
        WAIT_OBJECT_0 => Ok(false),
        WAIT_TIMEOUT => Ok(true),
        _ => Err(io::Error::last_os_error()),
    }
}
