use serde::Deserialize;
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Launch {
    node_executable: PathBuf,
    core_entry: PathBuf,
}

pub fn run(path: &Path) -> io::Result<i32> {
    if !path.is_absolute() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > 65536 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no pointer arguments and reads only the calling identity.
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    let launch: Launch = serde_json::from_slice(&fs::read(path)?)?;
    for entry in [&launch.node_executable, &launch.core_entry] {
        if !entry.is_absolute() || !fs::metadata(entry)?.is_file() {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    let mut command = Command::new(launch.node_executable);
    command
        .arg("--")
        .arg(launch.core_entry)
        .arg("--config")
        .arg(path)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    const NAMES: &[&str] = &[
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "PATH",
        "TMPDIR",
        "TZ",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_RUNTIME_DIR",
        "XDG_SESSION_ID",
        "XDG_SESSION_TYPE",
        "XDG_CURRENT_DESKTOP",
        "KDE_SESSION_VERSION",
        "DESKTOP_SESSION",
        "SystemRoot",
        "SystemDrive",
        "ProgramFiles",
        "ComSpec",
        "PATHEXT",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "USERNAME",
        "APPDATA",
        "LOCALAPPDATA",
    ];
    for key in NAMES {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(command.exec())
    }
    #[cfg(windows)]
    {
        let _job = crate::runtime_guard::guard_current_process()
            .map_err(|_| io::ErrorKind::PermissionDenied)?;
        Ok(command.status()?.code().unwrap_or(1))
    }
}
