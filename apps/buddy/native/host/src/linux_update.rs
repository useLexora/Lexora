use std::{
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use rustix::{
    event::{PollFd, PollFlags, Timespec, poll},
    fs::{FlockOperation, flock},
    process::{Pid, PidfdFlags, geteuid, pidfd_open},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const LOCK: &str = "/run/lexora-buddy-update.lock";
const EXECUTABLE: &str = "/opt/lexora-buddy/lexora-buddy";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Format {
    Pacman,
    Deb,
    Rpm,
}

impl Format {
    fn manager(&self) -> &'static str {
        match self {
            Self::Pacman => "/usr/bin/pacman",
            Self::Deb => "/usr/bin/apt-get",
            Self::Rpm => "/usr/bin/dnf",
        }
    }

    fn arguments(&self) -> &'static [&'static str] {
        match self {
            Self::Pacman => &["-U", "--noconfirm", "--"],
            Self::Deb => &["install", "--assume-yes", "--"],
            Self::Rpm => &["install", "--assumeyes"],
        }
    }

    fn extension(&self) -> &'static str {
        match self {
            Self::Pacman => ".pkg.tar.zst",
            Self::Deb => ".deb",
            Self::Rpm => ".rpm",
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Installation {
    format: Format,
    package: PathBuf,
    sha256: String,
    size: u64,
    parent: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Handoff {
    installation: Installation,
    version: String,
    receipt: PathBuf,
    log: PathBuf,
    arguments: Vec<String>,
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "UPDATE_INSTALL_INVALID")
}

fn read_line(reader: &mut impl BufRead) -> io::Result<String> {
    let mut line = String::new();
    reader.take(65_537).read_line(&mut line)?;
    if line.len() > 65_536 || !line.ends_with('\n') {
        return Err(invalid());
    }
    Ok(line)
}

fn send(writer: &mut impl Write, value: &str) -> io::Result<()> {
    writeln!(writer, "{value}")?;
    writer.flush()
}

pub fn installation_active() -> io::Result<bool> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(LOCK)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    match flock(&file, FlockOperation::NonBlockingLockShared) {
        Ok(()) => Ok(false),
        Err(rustix::io::Errno::WOULDBLOCK) => Ok(true),
        Err(error) => Err(error.into()),
    }
}

pub fn supervise() -> io::Result<()> {
    if geteuid().is_root() {
        return Err(invalid());
    }
    let mut input = io::stdin().lock();
    let handoff: Handoff = serde_json::from_str(&read_line(&mut input)?)?;
    let parent = i32::try_from(handoff.installation.parent)
        .ok()
        .and_then(Pid::from_raw)
        .ok_or_else(invalid)?;
    let parent_fd = pidfd_open(parent, PidfdFlags::empty())?;
    let log = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&handoff.log)?;
    let mut child = Command::new("/usr/bin/pkexec")
        .arg("--disable-internal-agent")
        .arg(std::env::current_exe()?)
        .arg("--install-linux-update")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(log)
        .spawn()?;
    let mut child_input = child.stdin.take().ok_or_else(invalid)?;
    let mut output = BufReader::new(child.stdout.take().ok_or_else(invalid)?);
    let sent = send(
        &mut child_input,
        &serde_json::to_string(&handoff.installation)?,
    )
    .is_ok();
    let ready = sent && read_line(&mut output).is_ok_and(|line| line == "ready\n");
    if !ready {
        drop(child_input);
        let cancelled = child.wait()?.code() == Some(126);
        if !cancelled {
            let _ = write_receipt(&handoff, "failed");
        }
        return send(
            &mut io::stdout().lock(),
            if cancelled { "cancelled" } else { "failed" },
        );
    }
    send(&mut io::stdout().lock(), "ready")?;
    if !read_line(&mut input).is_ok_and(|line| line == "commit\n") {
        drop(child_input);
        child.wait()?;
        return Ok(());
    }
    send(&mut child_input, "commit")?;
    drop(child_input);
    let success = child.wait()?.success();
    let receipt = write_receipt(&handoff, if success { "installed" } else { "failed" });
    if poll(
        &mut [PollFd::new(&parent_fd, PollFlags::IN)],
        Some(&Timespec {
            tv_sec: 0,
            tv_nsec: 0,
        }),
    )? != 0
    {
        Command::new(EXECUTABLE)
            .args(&handoff.arguments)
            .current_dir("/")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
    }
    receipt
}

fn write_receipt(handoff: &Handoff, outcome: &str) -> io::Result<()> {
    let temporary = handoff.receipt.with_extension("tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)?;
    serde_json::to_writer(
        &mut file,
        &serde_json::json!({ "version": handoff.version, "outcome": outcome }),
    )?;
    file.sync_all()?;
    fs::rename(temporary, &handoff.receipt)
}

pub fn install() -> io::Result<()> {
    if !geteuid().is_root() {
        return Err(invalid());
    }
    let uid: u32 = std::env::var("PKEXEC_UID")
        .map_err(|_| invalid())?
        .parse()
        .map_err(|_| invalid())?;
    if uid == 0 {
        return Err(invalid());
    }
    let mut input = io::stdin().lock();
    let installation: Installation = serde_json::from_str(&read_line(&mut input)?)?;
    let parent = i32::try_from(installation.parent)
        .ok()
        .and_then(Pid::from_raw)
        .ok_or_else(invalid)?;
    let parent_fd = pidfd_open(parent, PidfdFlags::empty())?;
    let proc = PathBuf::from(format!("/proc/{}", installation.parent));
    if fs::metadata(&proc)?.uid() != uid
        || fs::read_link(proc.join("exe"))? != Path::new(EXECUTABLE)
    {
        return Err(invalid());
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o644)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(LOCK)?;
    lock.set_permissions(fs::Permissions::from_mode(0o644))?;
    flock(&lock, FlockOperation::NonBlockingLockExclusive)?;
    let staged = stage_package(&installation, uid)?;
    send(&mut io::stdout().lock(), "ready")?;
    if read_line(&mut input)? != "commit\n" {
        return Err(invalid());
    }
    eprintln!("UPDATE_INSTALL_COMMITTED");
    let mut fds = [PollFd::new(&parent_fd, PollFlags::IN)];
    if poll(
        &mut fds,
        Some(&Timespec {
            tv_sec: 120,
            tv_nsec: 0,
        }),
    )? == 0
    {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "UPDATE_EXIT_TIMEOUT",
        ));
    }
    ensure_application_stopped()?;
    eprintln!("UPDATE_PACKAGE_MANAGER_STARTED");
    let status = Command::new(installation.format.manager())
        .args(installation.format.arguments())
        .arg(&staged.file)
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LANG", "C.UTF-8")
        .env("DEBIAN_FRONTEND", "noninteractive")
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::from(io::stderr().as_fd().try_clone_to_owned()?))
        .stderr(Stdio::inherit())
        .status()?;
    if !status.success() {
        return Err(io::Error::other("UPDATE_PACKAGE_MANAGER_FAILED"));
    }
    Ok(())
}

use std::os::fd::AsFd;

fn ensure_application_stopped() -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while application_running()? {
        if Instant::now() >= deadline {
            return Err(io::Error::other("UPDATE_APPLICATION_RUNNING"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

fn application_running() -> io::Result<bool> {
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|value| value.parse::<u32>().is_ok())
        {
            match fs::read_link(entry.path().join("exe")) {
                Ok(path) if path == Path::new(EXECUTABLE) => return Ok(true),
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                _ => {}
            }
        }
    }
    Ok(false)
}

struct StagedPackage {
    directory: PathBuf,
    file: PathBuf,
}

impl Drop for StagedPackage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn stage_package(installation: &Installation, uid: u32) -> io::Result<StagedPackage> {
    let name = installation
        .package
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(invalid)?;
    if !installation.package.is_absolute()
        || !name.starts_with("Lexora-Buddy-")
        || !name.ends_with(installation.format.extension())
        || installation.sha256.len() != 64
        || !installation
            .sha256
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
        || installation.size == 0
        || installation.size > 2 * 1024 * 1024 * 1024
    {
        return Err(invalid());
    }
    let mut source = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&installation.package)?;
    let metadata = source.metadata()?;
    if !metadata.is_file() || metadata.uid() != uid || metadata.len() != installation.size {
        return Err(invalid());
    }
    let directory = PathBuf::from(format!(
        "/var/tmp/lexora-buddy-update-{}",
        uuid::Uuid::new_v4()
    ));
    fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let staged = StagedPackage {
        file: directory.join(name),
        directory,
    };
    let mut target = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&staged.file)?;
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 65536];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > installation.size {
            return Err(invalid());
        }
        digest.update(&buffer[..count]);
        target.write_all(&buffer[..count])?;
    }
    if size != installation.size || format!("{:x}", digest.finalize()) != installation.sha256 {
        return Err(io::Error::other("UPDATE_PACKAGE_INVALID"));
    }
    target.sync_all()?;
    Ok(staged)
}

#[cfg(test)]
#[path = "../__tests__/linux_update.rs"]
mod tests;
