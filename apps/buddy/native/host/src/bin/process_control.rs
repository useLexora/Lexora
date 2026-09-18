use std::{io, process::ExitCode};

fn main() -> ExitCode {
    let mut arguments = std::env::args_os().skip(1);
    if let Some(command) = arguments.next() {
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
