mod broker;
mod cancellation;
mod filesystem;
mod metadata;
mod network;
mod policy;
mod process;
mod security;
mod setup;

use std::io;

const SERVICE_NAME: &str = "LexoraBuddySandboxNetwork";
const PIPE_NAME: &str = r"\\.\pipe\LexoraBuddySandboxNetwork-v1";
const PROFILE_PREFIX: &str = "Lexora.Buddy.Sandbox.";
const PROTOCOL_VERSION: u32 = 1;
const COMPONENT_VERSION: u32 = 1;

pub fn run() -> io::Result<i32> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.len() != 1 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    match arguments[0].as_str() {
        "version" => {
            println!(
                "{}",
                serde_json::json!({"protocol":PROTOCOL_VERSION,"version":COMPONENT_VERSION})
            );
            Ok(0)
        }
        "run" => process::run(),
        "status" => setup::status(),
        "health" => broker::Lease::health(),
        "setup" => setup::elevate("install"),
        "remove" => setup::elevate("uninstall"),
        "install" => setup::install(),
        "uninstall" => setup::uninstall(),
        "service" => broker::dispatch(),
        _ => Err(io::ErrorKind::InvalidInput.into()),
    }
}
