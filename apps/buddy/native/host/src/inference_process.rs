use std::{
    fs::{self, File},
    io::{self, BufRead, Read},
    os::windows::io::AsRawHandle,
    path::{Component, Path, PathBuf},
    ptr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::Deserialize;
use windows_sys::Win32::{
    Foundation::{
        DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE_FLAG_INHERIT, SetHandleInformation,
        WAIT_FAILED, WAIT_OBJECT_0,
    },
    Security::SECURITY_ATTRIBUTES,
    System::{
        Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE},
        JobObjects::AssignProcessToJobObject,
        Pipes::CreatePipe,
        SystemInformation::GetWindowsDirectoryW,
        Threading::*,
    },
};

use crate::{
    shell_sandbox::process::{Attributes, Child, Job},
    supervised_shell::windows::{boolean, owned, quote_argument, wide},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    executable: String,
    directory: PathBuf,
    entry: PathBuf,
    library_paths: Vec<String>,
    parent_pid: u32,
}

pub fn run() -> io::Result<i32> {
    let mut input = io::BufReader::new(io::stdin());
    let mut configuration = Vec::new();
    input
        .by_ref()
        .take(65537)
        .read_until(b'\n', &mut configuration)?;
    if configuration.len() > 65536 || configuration.last() != Some(&b'\n') {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let request: Request = serde_json::from_slice(&configuration)?;
    validate(&request)?;
    // SAFETY: The caller supplies its own live PID; retaining the handle prevents identity reuse during execution.
    let parent = owned(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, request.parent_pid) })?;
    let job = Job::host()?;
    let (child, writer) = launch(&request, &job)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let ended = Arc::clone(&cancelled);
    std::thread::spawn(move || {
        let _ = io::copy(&mut input, &mut File::from(writer));
        ended.store(true, Ordering::Release);
    });
    let result = loop {
        if cancelled.load(Ordering::Acquire) {
            break Ok(0);
        }
        // SAFETY: Both exact process handles remain owned throughout these waits.
        let parent_state = unsafe { WaitForSingleObject(parent.as_raw_handle(), 0) };
        if parent_state == WAIT_FAILED {
            break Err(io::Error::last_os_error());
        }
        if parent_state == WAIT_OBJECT_0 {
            break Ok(0);
        }
        // SAFETY: The owned child handle remains live until after Job cleanup.
        let state = unsafe { WaitForSingleObject(child.process.as_raw_handle(), 20) };
        if state == WAIT_FAILED {
            break Err(io::Error::last_os_error());
        }
        if state == WAIT_OBJECT_0 {
            let mut code = 0;
            // SAFETY: The exited process and writable exit-code output are valid.
            boolean(unsafe { GetExitCodeProcess(child.process.as_raw_handle(), &mut code) })?;
            break Ok(code as i32);
        }
    };
    job.finish()?;
    result
}

fn validate(request: &Request) -> io::Result<()> {
    if !Path::new(&request.executable).is_absolute()
        || !request.directory.is_absolute()
        || !request.entry.starts_with("native")
        || request.entry.extension().is_none_or(|value| value != "mjs")
        || !request
            .entry
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        || request.entry.to_string_lossy().contains([':', '\0'])
        || request.library_paths.len() > 64
        || request
            .library_paths
            .iter()
            .any(|path| !Path::new(path).is_absolute() || path.contains([';', '\0']))
        || request.parent_pid == 0
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let root = fs::canonicalize(&request.directory)?;
    for path in [
        request.directory.join("runtime.mjs"),
        request.directory.join("plugin").join(&request.entry),
    ] {
        let actual = fs::canonicalize(&path)?;
        if !actual.starts_with(&root) || !fs::metadata(actual)?.is_file() {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    if !fs::metadata(&request.executable)?.is_file() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(())
}

fn launch(request: &Request, job: &Job) -> io::Result<(Child, std::os::windows::io::OwnedHandle)> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    let mut read = ptr::null_mut();
    let mut write = ptr::null_mut();
    // SAFETY: New pipe handles have a single owner; only the read end enters the child's handle list.
    boolean(unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) })?;
    let input = owned(read)?;
    let writer = owned(write)?;
    // SAFETY: The write end is supervisor-private.
    boolean(unsafe { SetHandleInformation(writer.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) })?;
    let duplicate = |standard| {
        let mut output = ptr::null_mut();
        // SAFETY: Duplicate only the requested output handle, never the Job or supervisor control input.
        boolean(unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                GetStdHandle(standard),
                GetCurrentProcess(),
                &mut output,
                0,
                1,
                DUPLICATE_SAME_ACCESS,
            )
        })?;
        owned(output)
    };
    let stdout = duplicate(STD_OUTPUT_HANDLE)?;
    let stderr = duplicate(STD_ERROR_HANDLE)?;
    let handles = [
        input.as_raw_handle(),
        stdout.as_raw_handle(),
        stderr.as_raw_handle(),
    ];
    let mut attribute_list = Attributes::new(1)?;
    attribute_list.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, &handles)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input.as_raw_handle();
    startup.StartupInfo.hStdOutput = stdout.as_raw_handle();
    startup.StartupInfo.hStdError = stderr.as_raw_handle();
    startup.lpAttributeList = attribute_list.pointer();
    let root = request.directory.to_string_lossy();
    let bootstrap = request.directory.join("runtime.mjs");
    let entry = request.directory.join("plugin").join(&request.entry);
    let command_line = [
        request.executable.as_str(),
        bootstrap.to_str().ok_or(io::ErrorKind::InvalidInput)?,
        entry.to_str().ok_or(io::ErrorKind::InvalidInput)?,
    ]
    .into_iter()
    .map(quote_argument)
    .collect::<Vec<_>>()
    .join(" ");
    let mut command = wide(&command_line);
    if command.len() > 32767 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut windows = [0u16; 32768];
    // SAFETY: This writable buffer is large enough for the documented maximum Windows path.
    let length =
        unsafe { GetWindowsDirectoryW(windows.as_mut_ptr(), windows.len() as u32) } as usize;
    if length == 0 || length >= windows.len() {
        return Err(io::Error::last_os_error());
    }
    let windows = String::from_utf16_lossy(&windows[..length]);
    let executable_directory = Path::new(&request.executable)
        .parent()
        .ok_or(io::ErrorKind::InvalidInput)?;
    let mut paths = request.library_paths.clone();
    paths.push(executable_directory.to_string_lossy().into_owned());
    paths.push(format!("{windows}\\System32"));
    let path = paths.join(";");
    let variables = [
        ("APPDATA", root.as_ref()),
        ("ELECTRON_RUN_AS_NODE", "1"),
        ("HOME", root.as_ref()),
        ("LOCALAPPDATA", root.as_ref()),
        ("PATH", &path),
        ("SystemRoot", &windows),
        ("TEMP", root.as_ref()),
        ("TMP", root.as_ref()),
        ("USERPROFILE", root.as_ref()),
    ];
    let mut environment: Vec<u16> = variables
        .into_iter()
        .flat_map(|(key, value)| wide(&format!("{key}={value}")))
        .chain([0])
        .collect();
    let mut information = PROCESS_INFORMATION::default();
    // SAFETY: Buffers stay live; the child is suspended and inherits only its three I/O handles.
    boolean(unsafe {
        CreateProcessW(
            wide(&request.executable).as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | CREATE_SUSPENDED,
            environment.as_mut_ptr().cast(),
            wide(&root).as_ptr(),
            &startup.StartupInfo,
            &mut information,
        )
    })?;
    let child = Child {
        process: owned(information.hProcess)?,
        thread: owned(information.hThread)?,
    };
    // SAFETY: Assignment happens before any code can spawn descendants; breakaway is disabled by Job::host.
    boolean(unsafe {
        AssignProcessToJobObject(job.0.as_raw_handle(), child.process.as_raw_handle())
    })?;
    // SAFETY: Resume only after successful Job assignment.
    if unsafe { ResumeThread(child.thread.as_raw_handle()) } == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    Ok((child, writer))
}
