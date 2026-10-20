use std::{
    fs,
    io::{self, Write},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use super::{Request, Transport};
use rustix::process::{Pid, Signal, WaitOptions, kill_process, set_child_subreaper, wait};

pub(super) struct Supervision;

pub(super) fn initialize() -> io::Result<Supervision> {
    set_child_subreaper(Pid::from_raw(1))?;
    Ok(Supervision)
}

pub(super) fn identity(_supervision: &Supervision) -> io::Result<serde_json::Value> {
    let stat = fs::read_to_string("/proc/self/stat")?;
    let start = stat
        .rsplit_once(')')
        .and_then(|(_, fields)| fields.split_whitespace().nth(19))
        .ok_or(io::ErrorKind::InvalidData)?;
    Ok(
        serde_json::json!({"version":2,"pid":std::process::id(),"startTime":start,"bootId":fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim()}),
    )
}

pub(super) fn run(
    _supervision: &Supervision,
    request: &Request,
    cancelled: &AtomicBool,
    receipt: Option<&super::receipt::Receipt>,
) -> io::Result<i32> {
    let result = execute(request, cancelled);
    cleanup()?;
    if let Some(receipt) = receipt {
        receipt.release()?;
    }
    super::released();
    result
}

fn execute(request: &Request, cancelled: &AtomicBool) -> io::Result<i32> {
    if cancelled.load(Ordering::Acquire) {
        return Err(io::ErrorKind::Interrupted.into());
    }
    let stdin_transport = matches!(request.command_transport, Transport::Stdin);
    let mut command = Command::new(&request.shell);
    command
        .args(&request.args)
        .current_dir(&request.cwd)
        .env_clear()
        .envs(&request.environment)
        .stdin(if stdin_transport {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::inherit())
        .stderr(Stdio::piped());
    if !stdin_transport {
        command.arg(&request.command);
    }
    let mut child = command.spawn()?;
    let error_output = child.stderr.take().ok_or(io::ErrorKind::BrokenPipe)?;
    let output = std::thread::spawn(move || io::copy(&mut { error_output }, &mut io::stdout()));
    let input = if stdin_transport {
        let mut stdin = child.stdin.take().ok_or(io::ErrorKind::BrokenPipe)?;
        let script = request.command.clone();
        Some(std::thread::spawn(move || {
            stdin.write_all(script.as_bytes())
        }))
    } else {
        None
    };
    let result = loop {
        if cancelled.load(Ordering::Acquire) {
            break Err(io::ErrorKind::Interrupted.into());
        }
        if let Some(status) = child.try_wait()? {
            break Ok(status.code().unwrap_or(128));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    cleanup()?;
    // The reaper has closed inherited pipes; joining cannot be held open by a detached descendant.
    output.join().map_err(|_| io::ErrorKind::Other)??;
    if let Some(input) = input {
        let _ = input.join();
    }
    result
}

fn cleanup() -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let children =
            fs::read_to_string(format!("/proc/self/task/{}/children", std::process::id()))?;
        for child in children.split_whitespace() {
            let pid = child
                .parse::<i32>()
                .ok()
                .and_then(Pid::from_raw)
                .ok_or(io::ErrorKind::InvalidData)?;
            match kill_process(pid, Signal::KILL) {
                Ok(()) | Err(rustix::io::Errno::SRCH) => {}
                Err(error) => return Err(error.into()),
            }
        }
        loop {
            match wait(WaitOptions::NOHANG) {
                Err(rustix::io::Errno::CHILD) => return Ok(()),
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(rustix::io::Errno::INTR) => {}
                Err(error) => return Err(error.into()),
            }
        }
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
