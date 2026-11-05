#[cfg(unix)]
#[path = "../src/inference_process_macos.rs"]
mod inference_process;

#[cfg(unix)]
fn main() -> std::process::ExitCode {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["--supervise-inference"] {
        return std::process::ExitCode::FAILURE;
    }
    match inference_process::run() {
        Ok(code) => std::process::ExitCode::from(code.clamp(0, 255) as u8),
        Err(error) => {
            eprintln!("EXTENSION_INFERENCE_SUPERVISION_FAILED: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(not(unix))]
fn main() {}
