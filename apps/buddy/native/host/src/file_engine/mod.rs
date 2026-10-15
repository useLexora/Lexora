mod io;
mod journal;
mod operations;
pub mod protocol;
mod resources;
mod server;
mod trash;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod windows_shell;

pub use server::serve;
