use std::{
    fs::File,
    io::{self, Write},
    os::windows::io::{AsRawHandle, OwnedHandle},
    ptr,
    sync::atomic::{AtomicBool, Ordering},
};

use super::{Request, Transport};
use crate::shell_sandbox::process::{Attributes, Child, Job};
use windows_sys::Win32::{
    Foundation::{
        DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation,
        WAIT_FAILED, WAIT_OBJECT_0,
    },
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::{CreateFileW, FILE_GENERIC_READ, OPEN_EXISTING},
    System::{
        Console::{GetStdHandle, STD_OUTPUT_HANDLE},
        JobObjects::AssignProcessToJobObject,
        Pipes::CreatePipe,
        Threading::*,
    },
};

pub(super) fn initialize() -> io::Result<Job> {
    Job::host()
}

pub(crate) fn identity(job: &Job) -> io::Result<serde_json::Value> {
    use super::recovery::backend::{boot_id, start_time};
    // SAFETY: This pseudo handle denotes the live supervisor.
    let start = start_time(unsafe { GetCurrentProcess() })?;
    Ok(serde_json::json!({
        "version":2, "pid":std::process::id(), "startTime":start.to_string(),
        "bootId":boot_id()?, "jobName":job.name()
    }))
}

pub(super) fn run(job: &Job, request: &Request, cancelled: &AtomicBool) -> io::Result<i32> {
    let result = execute(request, cancelled, job);
    job.finish()?;
    super::released();
    result
}

fn execute(request: &Request, cancelled: &AtomicBool, job: &Job) -> io::Result<i32> {
    if cancelled.load(Ordering::Acquire) {
        return Err(io::ErrorKind::Interrupted.into());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    let mut output_handle = ptr::null_mut();
    // SAFETY: Only a duplicate of stdout is inherited. The supervisor's stderr protocol and control stdin remain private.
    boolean(unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            GetStdHandle(STD_OUTPUT_HANDLE),
            GetCurrentProcess(),
            &mut output_handle,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    })?;
    let output = owned(output_handle)?;
    let mut input_write = None;
    let input = if matches!(request.command_transport, Transport::Stdin) {
        let mut read = ptr::null_mut();
        let mut write = ptr::null_mut();
        // SAFETY: The pipe receives two owned handles; only its read end is in the child handle list.
        boolean(unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) })?;
        let read = owned(read)?;
        let write = owned(write)?;
        // SAFETY: This live write handle must stay private to the supervisor.
        boolean(unsafe { SetHandleInformation(write.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) })?;
        input_write = Some(write);
        read
    } else {
        // SAFETY: The fixed NUL device supplies EOF and carries no supervisor control input.
        owned(unsafe {
            CreateFileW(
                wide("NUL").as_ptr(),
                FILE_GENERIC_READ,
                3,
                &attributes,
                OPEN_EXISTING,
                0,
                ptr::null_mut(),
            )
        })?
    };
    let handles = [input.as_raw_handle(), output.as_raw_handle()];
    let mut attribute_list = Attributes::new(1)?;
    attribute_list.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, &handles)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input.as_raw_handle();
    startup.StartupInfo.hStdOutput = output.as_raw_handle();
    startup.StartupInfo.hStdError = output.as_raw_handle();
    startup.lpAttributeList = attribute_list.pointer();
    let mut arguments = vec![request.shell.as_str()];
    arguments.extend(request.args.iter().map(String::as_str));
    if matches!(request.command_transport, Transport::Argv) {
        arguments.push(&request.command);
    }
    let mut command = wide(
        &arguments
            .into_iter()
            .map(quote_argument)
            .collect::<Vec<_>>()
            .join(" "),
    );
    if command.len() > 32767 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut environment: Vec<u16> = request
        .environment
        .iter()
        .flat_map(|(key, value)| wide(&format!("{key}={value}")))
        .chain([0])
        .collect();
    let mut information = PROCESS_INFORMATION::default();
    // SAFETY: All buffers remain live, the handle list excludes the control channel, and the suspended child cannot spawn before Job assignment.
    boolean(unsafe {
        CreateProcessW(
            wide(&request.shell).as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | CREATE_SUSPENDED,
            environment.as_mut_ptr().cast(),
            wide(&request.cwd).as_ptr(),
            &startup.StartupInfo,
            &mut information,
        )
    })?;
    let child = Child {
        process: owned(information.hProcess)?,
        thread: owned(information.hThread)?,
    };
    // SAFETY: The private Job and this suspended child are live, and breakaway is not enabled.
    boolean(unsafe {
        AssignProcessToJobObject(job.0.as_raw_handle(), child.process.as_raw_handle())
    })?;
    // SAFETY: The initial thread starts only after successful Job assignment.
    if unsafe { ResumeThread(child.thread.as_raw_handle()) } == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    let writer = input_write.map(|input| {
        let script = request.command.clone();
        std::thread::spawn(move || File::from(input).write_all(script.as_bytes()))
    });
    let result = loop {
        if cancelled.load(Ordering::Acquire) {
            break Err(io::ErrorKind::Interrupted.into());
        }
        // SAFETY: This owned process handle stays live throughout the wait.
        let wait = unsafe { WaitForSingleObject(child.process.as_raw_handle(), 20) };
        if wait == WAIT_FAILED {
            return Err(io::Error::last_os_error());
        }
        if wait == WAIT_OBJECT_0 {
            let mut code = 0;
            // SAFETY: The process is finished and the exit code output is writable.
            boolean(unsafe { GetExitCodeProcess(child.process.as_raw_handle(), &mut code) })?;
            break Ok(code as i32);
        }
    };
    job.finish()?;
    drop(child);
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    result
}

fn quote_argument(argument: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in argument.chars() {
        if character == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            if character == '"' {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        result.push(character);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

pub(crate) fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}
pub(crate) fn boolean(value: i32) -> io::Result<()> {
    if value == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
pub(crate) fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    use std::os::windows::io::FromRawHandle;
    if handle.is_null() || handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: The caller transfers a newly created valid handle exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}
