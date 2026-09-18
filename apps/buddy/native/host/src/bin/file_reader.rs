use std::{io, process::ExitCode};

fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("--save-text") {
        return match lexora_buddy_host::file_writer::run(io::stdin().lock()) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::FAILURE
            }
        };
    }
    match lexora_buddy_host::file_reader::run(io::stdin().lock(), io::stdout().lock()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
