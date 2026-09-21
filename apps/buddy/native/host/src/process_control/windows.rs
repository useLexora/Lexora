use std::collections::HashSet;

use crate::windows_security::{Sid, process_user_sid};

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
    },
};

use super::{
    Action, MAX_OUTPUT_BYTES, ProcessError, Request, Selector,
    policy::{self, Target},
    process_name,
};

mod identity;
mod snapshot;
mod window;

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: This wrapper exclusively owns a successful Win32 handle acquisition.
        unsafe { CloseHandle(self.0) };
    }
}

fn open(pid: u32, action: Option<Action>) -> Result<Option<Handle>, ProcessError> {
    let rights = PROCESS_QUERY_LIMITED_INFORMATION
        | PROCESS_SYNCHRONIZE
        | if action == Some(Action::Kill) {
            PROCESS_TERMINATE
        } else {
            0
        };
    // SAFETY: The validated PID names a local process; no handle inheritance or privilege adjustment.
    let handle = unsafe { OpenProcess(rights, 0, pid) };
    if !handle.is_null() {
        return Ok(Some(Handle(handle)));
    }
    // SAFETY: Read immediately after the failed Win32 call.
    if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
        Ok(None)
    } else {
        Err(ProcessError::Failed)
    }
}

fn running(handle: &Handle, wait_ms: u32) -> Result<bool, ProcessError> {
    // SAFETY: The live process handle includes SYNCHRONIZE access.
    match unsafe { WaitForSingleObject(handle.0, wait_ms) } {
        WAIT_OBJECT_0 => Ok(false),
        WAIT_TIMEOUT => Ok(true),
        _ => Err(ProcessError::Failed),
    }
}

pub(super) fn executable_running(executable: &str) -> Result<bool, ProcessError> {
    let expected = match std::fs::canonicalize(executable) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(ProcessError::Failed),
    };
    let name = expected
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(ProcessError::Invalid)?;
    let expected = expected.to_str().ok_or(ProcessError::Invalid)?;
    for entry in snapshot::read()? {
        if !snapshot::same_name(&entry.name, name) {
            continue;
        }
        let Ok(Some(handle)) = open(entry.pid, None) else {
            continue;
        };
        if !running(&handle, 0).unwrap_or(false) {
            continue;
        }
        let Ok(executable) = identity::executable(&handle) else {
            continue;
        };
        if !running(&handle, 0).unwrap_or(false) {
            continue;
        }
        let Ok(actual) = std::fs::canonicalize(&executable) else {
            continue;
        };
        let Some(actual_str) = actual.to_str() else {
            continue;
        };
        if snapshot::same_name(actual_str, expected) && running(&handle, 0).unwrap_or(false) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn inspect(
    handle: &Handle,
    pid: u32,
    protected: &HashSet<u32>,
    owner: &Sid,
) -> Result<Option<Target>, ProcessError> {
    if !running(handle, 0)? {
        return Ok(None);
    }
    let mut target = identity::target(handle, pid)?;
    let protected = pid <= 4 || protected.contains(&pid);
    let same_owner = !protected && process_user_sid(handle.0).is_ok_and(|sid| &sid == owner);
    let critical = identity::is_critical(handle).unwrap_or(true);
    let has_window = !protected && same_owner && !critical && window::main_window(pid).is_some();
    target.allowed_actions = policy::allowed_actions(protected, same_owner, critical, has_window);
    Ok(running(handle, 0)?.then_some(target))
}

pub(super) fn request(request: &Request) -> Result<Vec<u8>, ProcessError> {
    let snapshot = snapshot::read()?;
    let mut roots: Vec<u32> = request
        .protected_pids()
        .iter()
        .map(|pid| pid.get())
        .collect();
    // SAFETY: These process-local queries take no input and the pseudo handle is borrowed, not closed.
    let (self_pid, owner) = unsafe {
        (
            GetCurrentProcessId(),
            process_user_sid(GetCurrentProcess()).map_err(|_| ProcessError::Failed)?,
        )
    };
    roots.push(self_pid);
    let parents = snapshot
        .iter()
        .map(|entry| (entry.pid, entry.parent))
        .collect();
    let protected = policy::protected_processes(&parents, &roots);
    let (pids, action) = match request {
        Request::Resolve { selector, .. } => (
            match selector {
                Selector::Pid { pid } => vec![pid.get()],
                Selector::Name { name } => snapshot
                    .iter()
                    .filter(|entry| {
                        snapshot::same_name(process_name(&entry.name), process_name(name))
                    })
                    .map(|entry| entry.pid)
                    .collect(),
            },
            None,
        ),
        Request::Read { pid, .. } => (vec![pid.get()], None),
        Request::Execute { pid, action, .. } => (vec![pid.get()], Some(*action)),
    };
    let mut targets = Vec::new();
    let mut bytes = 2;
    for pid in pids {
        if action.is_some() && (pid <= 4 || protected.contains(&pid)) {
            return Err(ProcessError::NotAllowed);
        }
        let Some(handle) = open(pid, action)? else {
            continue;
        };
        let Some(target) = inspect(&handle, pid, &protected, &owner)? else {
            continue;
        };
        if let Request::Resolve {
            selector: Selector::Name { name },
            ..
        } = request
            && !snapshot::same_name(&target.display_name, process_name(name))
        {
            continue;
        }
        if let Request::Execute {
            instance_id,
            executable,
            action,
            ..
        } = request
        {
            policy::validate_execution(&target, pid, instance_id, executable, *action)?;
            execute(&handle, pid, *action)?;
        }
        bytes += serde_json::to_vec(&target)
            .map_err(|_| ProcessError::Failed)?
            .len()
            + 1;
        if bytes > MAX_OUTPUT_BYTES || targets.len() >= 4096 {
            return Err(ProcessError::Failed);
        }
        targets.push(target);
    }
    if action.is_some() && targets.len() != 1 {
        return Err(ProcessError::TargetChanged);
    }
    serde_json::to_vec(&targets).map_err(|_| ProcessError::Failed)
}

fn execute(handle: &Handle, pid: u32, action: Action) -> Result<(), ProcessError> {
    if !running(handle, 0)? {
        return Err(ProcessError::TargetChanged);
    }
    match action {
        Action::Kill => {
            // SAFETY: This is the same identity-checked handle opened with PROCESS_TERMINATE.
            if unsafe { TerminateProcess(handle.0, 1) } == 0 {
                return Err(ProcessError::Failed);
            }
        }
        Action::Terminate => {
            let window = window::main_window(pid).ok_or(ProcessError::NotAllowed)?;
            if !running(handle, 0)? {
                return Err(ProcessError::TargetChanged);
            }
            window::close(window, pid)?;
        }
    }
    let _ = running(handle, 2000)?;
    Ok(())
}
