use std::process::ExitCode;

#[cfg(windows)]
#[path = "provider_credential/windows.rs"]
mod windows;

fn main() -> ExitCode {
    #[cfg(windows)]
    if std::env::args_os().nth(1).is_none() && windows::run().is_ok() {
        return ExitCode::SUCCESS;
    }
    ExitCode::FAILURE
}
