use std::{io, process::ExitCode};

fn main() -> ExitCode {
    let mut arguments = std::env::args_os().skip(1);
    #[cfg(target_os = "linux")]
    if std::env::var_os("ARGV0").as_deref() == Some(std::ffi::OsStr::new("lexora-sandbox-ipc")) {
        return ipc_result(lexora_buddy_host::sandbox_ipc::launch(arguments));
    }
    if let Some(command) = arguments.next() {
        #[cfg(target_os = "linux")]
        if matches!(
            command.to_str(),
            Some("--supervise-linux-update" | "--install-linux-update" | "--check-linux-update")
        ) && arguments.next().is_none()
        {
            use lexora_buddy_host::linux_update;
            let result = match command.to_str() {
                Some("--supervise-linux-update") => linux_update::supervise().map(|()| false),
                Some("--install-linux-update") => linux_update::install().map(|()| false),
                _ => linux_update::installation_active(),
            };
            return match result {
                Ok(false) => ExitCode::SUCCESS,
                Ok(true) => ExitCode::from(32),
                Err(error) => {
                    eprintln!("UPDATE_INSTALL_FAILED: {error}");
                    ExitCode::FAILURE
                }
            };
        }
        #[cfg(target_os = "linux")]
        if command == "--sandbox-ipc-worker" {
            return ipc_result(lexora_buddy_host::sandbox_ipc::execute(arguments));
        }
        #[cfg(target_os = "linux")]
        if command == "--probe-sandbox-ipc" && arguments.next().is_none() {
            return match lexora_buddy_host::sandbox_ipc::probe() {
                Ok(available) => {
                    println!(
                        "{}",
                        serde_json::json!({"protocol":1,"privateUnixSockets":available})
                    );
                    ExitCode::SUCCESS
                }
                Err(error) => ipc_result(Err(error)),
            };
        }
        #[cfg(any(windows, target_os = "linux"))]
        if command == "--supervise-shell" && arguments.next().is_none() {
            return match lexora_buddy_host::supervised_shell::run() {
                Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
                Err(error) => {
                    eprintln!(
                        "{}",
                        serde_json::json!({"type":"failed","code":"SHELL_SUPERVISION_FAILED","nativeCode":error.raw_os_error()})
                    );
                    ExitCode::FAILURE
                }
            };
        }
        #[cfg(windows)]
        if command == "--check-installation" && arguments.next().is_none() {
            return match lexora_buddy_host::installation_gate::installation_active() {
                Ok(false) => ExitCode::SUCCESS,
                Ok(true) => ExitCode::from(32),
                Err(error) => {
                    eprintln!("INSTALLATION_CHECK_FAILED: {error}");
                    ExitCode::FAILURE
                }
            };
        }
        #[cfg(windows)]
        if command == "--check-running" {
            return check_running(arguments);
        }
        let _ = command;
        eprintln!("SYSTEM_ACTION_INVALID");
        return ExitCode::FAILURE;
    }
    match lexora_buddy_host::process_control::run(io::stdin().lock(), io::stdout().lock()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(target_os = "linux")]
fn ipc_result(result: io::Result<()>) -> ExitCode {
    if let Err(error) = result {
        eprintln!("SANDBOX_IPC_ISOLATION_FAILED: {error}");
    }
    ExitCode::FAILURE
}

#[cfg(windows)]
fn check_running(mut arguments: impl Iterator<Item = std::ffi::OsString>) -> ExitCode {
    use lexora_buddy_host::process_control::{ProcessError, executable_running};

    let started = std::time::Instant::now();
    let executable = arguments.next();
    let result = match (
        executable.as_deref().and_then(|path| path.to_str()),
        arguments.next(),
    ) {
        (Some(path), None) => executable_running(path),
        _ => Err(ProcessError::Invalid),
    };
    let (status, error, code) = match result {
        Ok(false) => ("ready", None, ExitCode::SUCCESS),
        Ok(true) => ("running", None, ExitCode::from(32)),
        Err(error) => ("failed", Some(error.to_string()), ExitCode::FAILURE),
    };
    println!(
        "{}",
        serde_json::json!({
            "operation": "check-running",
            "architecture": std::env::consts::ARCH,
            "elapsedMs": started.elapsed().as_millis(),
            "status": status,
            "error": error,
        })
    );
    code
}
