use windows_sys::Win32::{
    Foundation::{FILETIME, SYSTEMTIME},
    System::{
        Threading::{GetProcessTimes, IsProcessCritical, QueryFullProcessImageNameW},
        Time::FileTimeToSystemTime,
    },
};

use super::{Handle, ProcessError, Target, process_name};

pub(super) fn executable(handle: &Handle) -> Result<String, ProcessError> {
    let mut path = vec![0u16; 32768];
    let mut len = path.len() as u32;
    // SAFETY: The process handle permits querying; path has the declared UTF-16 capacity.
    if unsafe { QueryFullProcessImageNameW(handle.0, 0, path.as_mut_ptr(), &mut len) } == 0 {
        return Err(ProcessError::Failed);
    }
    String::from_utf16(path.get(..len as usize).ok_or(ProcessError::Failed)?)
        .map_err(|_| ProcessError::Failed)
}

pub(super) fn target(handle: &Handle, pid: u32) -> Result<Target, ProcessError> {
    let executable = executable(handle)?;
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: The same process handle is live and all FILETIME outputs are writable.
    if unsafe { GetProcessTimes(handle.0, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(ProcessError::Failed);
    }
    let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    let mut date = SYSTEMTIME::default();
    // SAFETY: Creation was initialized by GetProcessTimes; date is writable.
    if unsafe { FileTimeToSystemTime(&creation, &mut date) } == 0 {
        return Err(ProcessError::Failed);
    }
    let started_at = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:07}Z",
        date.wYear,
        date.wMonth,
        date.wDay,
        date.wHour,
        date.wMinute,
        date.wSecond,
        ticks % 10_000_000
    );
    Ok(Target {
        kind: "process",
        pid,
        display_name: process_name(executable.rsplit('\\').next().ok_or(ProcessError::Failed)?)
            .to_owned(),
        executable,
        instance_id: ticks.to_string(),
        started_at,
        interruption: "application",
        allowed_actions: Vec::new(),
    })
}

pub(super) fn is_critical(handle: &Handle) -> Result<bool, ProcessError> {
    let mut critical = 0;
    // SAFETY: The live process handle has query access and the BOOL output is writable.
    if unsafe { IsProcessCritical(handle.0, &mut critical) } == 0 {
        return Err(ProcessError::Failed);
    }
    Ok(critical != 0)
}
