use std::{
    fs,
    io::{self, BufRead, Read},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde::Deserialize;

#[cfg(target_os = "macos")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

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
    let mut supervision = Supervision::new()?;
    let input_closure = InputClosure::new()?;
    let mut command = Command::new(&request.executable);
    command
        .arg(request.directory.join("runtime.mjs"))
        .arg(request.directory.join("plugin").join(&request.entry))
        .current_dir(&request.directory)
        .env_clear()
        .env("ELECTRON_RUN_AS_NODE", "1")
        .env("HOME", &request.directory)
        .env("TMPDIR", &request.directory)
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if !request.library_paths.is_empty() {
        command.env("DYLD_LIBRARY_PATH", request.library_paths.join(":"));
    }
    // No pre_exec: macOS must retain Command's posix_spawn path for Metal/XPC.
    let mut child = command.spawn()?;
    let mut writer = child.stdin.take().ok_or(io::ErrorKind::BrokenPipe)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let ended = Arc::clone(&cancelled);
    std::thread::spawn(move || {
        let _ = io::copy(&mut input, &mut writer);
        ended.store(true, Ordering::Release);
    });
    let result = loop {
        // SAFETY: getppid has no pointer arguments; reparenting cannot reuse this parent identity.
        if unsafe { libc::getppid() } as u32 != request.parent_pid
            || cancelled.load(Ordering::Acquire)
        {
            break Ok(0);
        }
        match input_closure.closed() {
            Ok(true) => break Ok(0),
            Ok(false) => {}
            Err(error) => break Err(error),
        }
        match supervision.watcher_alive() {
            Ok(true) => {}
            Ok(false) => break Err(io::ErrorKind::BrokenPipe.into()),
            Err(error) => break Err(error),
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.code().unwrap_or(128)),
            Ok(None) => {}
            Err(error) => break Err(error),
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    supervision.finish()?;
    child.wait()?;
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
        || request.entry.to_string_lossy().contains([':', '\\', '\0'])
        || request.library_paths.len() > 64
        || request
            .library_paths
            .iter()
            .any(|path| !Path::new(path).is_absolute() || path.contains([':', '\0']))
        || request.parent_pid == 0
        // SAFETY: The request must name this helper's current direct parent, not an arbitrary PID.
        || request.parent_pid != unsafe { libc::getppid() } as u32
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

#[cfg(target_os = "macos")]
struct InputClosure(OwnedFd);

#[cfg(target_os = "macos")]
impl InputClosure {
    fn new() -> io::Result<Self> {
        // SAFETY: kqueue creates a new descriptor owned only by this supervisor.
        let descriptor = unsafe { libc::kqueue() };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: A successful kqueue descriptor has not yet been wrapped or closed.
        let queue = unsafe { OwnedFd::from_raw_fd(descriptor) };
        // SAFETY: The owned descriptor is live; no worker exists yet to inherit it.
        if unsafe { libc::fcntl(queue.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let change = libc::kevent {
            ident: libc::STDIN_FILENO as libc::uintptr_t,
            filter: libc::EVFILT_READ,
            flags: libc::EV_ADD,
            fflags: 0,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        // SAFETY: Register one live stdin descriptor, without requesting any output events.
        if unsafe {
            libc::kevent(
                queue.as_raw_fd(),
                &change,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(queue))
    }

    fn closed(&self) -> io::Result<bool> {
        // SAFETY: All-zero kevent is a valid writable output buffer.
        let mut event: libc::kevent = unsafe { std::mem::zeroed() };
        let timeout = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: Poll one event on the live queue with a valid zero timeout; this never consumes stdin.
        let count = unsafe {
            libc::kevent(
                self.0.as_raw_fd(),
                std::ptr::null(),
                0,
                &mut event,
                1,
                &timeout,
            )
        };
        if count < 0 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::Interrupted {
                Ok(false)
            } else {
                Err(error)
            };
        }
        if count > 0 && event.flags & libc::EV_ERROR != 0 {
            return Err(io::Error::from_raw_os_error(event.data as i32));
        }
        // EV_EOF reports pipe/socket closure even with unread buffered bytes.
        Ok(count > 0 && event.flags & libc::EV_EOF != 0)
    }
}

#[cfg(target_os = "linux")]
struct InputClosure;

#[cfg(target_os = "linux")]
impl InputClosure {
    fn new() -> io::Result<Self> {
        Ok(Self)
    }

    fn closed(&self) -> io::Result<bool> {
        let mut descriptor = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLRDHUP,
            revents: 0,
        };
        // SAFETY: Poll the live stdin descriptor without reading or changing its flags.
        if unsafe { libc::poll(&mut descriptor, 1, 0) } < 0 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::Interrupted {
                Ok(false)
            } else {
                Err(error)
            };
        }
        if descriptor.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        Ok(descriptor.revents & (libc::POLLHUP | libc::POLLRDHUP) != 0)
    }
}

struct Supervision {
    group: libc::pid_t,
    original_group: libc::pid_t,
    watcher: Option<libc::pid_t>,
    finished: bool,
}

impl Supervision {
    fn new() -> io::Result<Self> {
        // SAFETY: This narrow binary mode is single-threaded before the watcher is forked.
        let (group, original_group) = unsafe { (libc::getpid(), libc::getpgrp()) };
        if group == original_group {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        // SAFETY: Only this helper's process group is changed; children do not exist yet.
        if unsafe { libc::setpgid(0, 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: No threads exist. The child uses only async-signal-safe syscalls, never Rust/ObjC runtime work.
        let watcher = unsafe { libc::fork() };
        if watcher == -1 {
            return Err(io::Error::last_os_error());
        }
        if watcher == 0 {
            let delay = libc::timespec {
                tv_sec: 0,
                tv_nsec: 20_000_000,
            };
            // SAFETY: The watcher anchors the owned group ID until killpg, and exits with the group.
            unsafe {
                while libc::getppid() == group {
                    libc::nanosleep(&delay, std::ptr::null_mut());
                }
                libc::kill(-group, libc::SIGKILL);
                libc::_exit(1);
            }
        }
        Ok(Self {
            group,
            original_group,
            watcher: Some(watcher),
            finished: false,
        })
    }

    fn watcher_alive(&mut self) -> io::Result<bool> {
        let Some(watcher) = self.watcher else {
            return Ok(false);
        };
        let mut status = 0;
        // SAFETY: watcher is our unreaped direct child and status is writable.
        let result = unsafe { libc::waitpid(watcher, &mut status, libc::WNOHANG) };
        if result == 0 {
            return Ok(true);
        }
        if result == watcher {
            self.watcher = None;
            return Ok(false);
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            return Ok(true);
        }
        Err(error)
    }

    fn finish(&mut self) -> io::Result<()> {
        if self.finished {
            return Ok(());
        }
        // SAFETY: Leave the owned group before killing it. If the old group vanished, kill includes this helper.
        unsafe { libc::setpgid(0, self.original_group) };
        // SAFETY: Our live PID pins this group ID even after leaving it; no unrelated group can reuse it.
        if unsafe { libc::kill(-self.group, libc::SIGKILL) } != 0
            && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        {
            return Err(io::Error::last_os_error());
        }
        self.finished = true;
        if let Some(watcher) = self.watcher.take() {
            let mut status = 0;
            loop {
                // SAFETY: Reap only our owned watcher after signalling the group.
                if unsafe { libc::waitpid(watcher, &mut status, 0) } == watcher {
                    break;
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
        Ok(())
    }
}

impl Drop for Supervision {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}
