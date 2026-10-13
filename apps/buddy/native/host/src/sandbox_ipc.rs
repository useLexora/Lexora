use rustix::fs::{AtFlags, CWD, StatxFlags, statx};
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io,
    mem::size_of,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{fs::OpenOptionsExt, process::CommandExt},
    },
    process::Command,
};

const RESOLVE_UNIX: u64 = 1 << 16;
const SCOPE_ABSTRACT_UNIX: u64 = 1;
const SCOPE_SIGNAL: u64 = 2;
const LOAD: u16 = (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16;
const RETURN: u16 = (libc::BPF_RET | libc::BPF_K) as u16;
const EQUAL: u16 = (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16;

#[repr(C)]
struct Ruleset {
    handled_access_fs: u64,
    handled_access_net: u64,
    scoped: u64,
}

pub fn probe() -> io::Result<bool> {
    // SAFETY: The version query takes no pointers and does not change the process policy.
    let version = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, 0, 0, 1) };
    if version < 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ENOSYS | libc::EOPNOTSUPP) => Ok(false),
            _ => Err(error),
        };
    }
    if version < 9 {
        return Ok(false);
    }
    isolate()?;
    Ok(true)
}

pub fn launch(arguments: impl Iterator<Item = OsString>) -> io::Result<()> {
    let arguments: Vec<_> = arguments.collect();
    if arguments.is_empty() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let bwrap =
        std::env::var_os("LEXORA_BUDDY_SANDBOX_BWRAP").ok_or(io::ErrorKind::InvalidInput)?;
    let executable = std::env::current_exe()?;
    let temporary =
        std::env::var_os("LEXORA_BUDDY_SANDBOX_TMP").ok_or(io::ErrorKind::InvalidInput)?;
    let remap_temporary = temporary != "/tmp";
    let mounts = if remap_temporary {
        temporary_mounts()?
    } else {
        Vec::new()
    };
    // A second PID namespace keeps the unfiltered proxy relays out of the workload's /proc.
    let mut command = Command::new(bwrap);
    command.args([
        "--unshare-user",
        "--unshare-pid",
        "--die-with-parent",
        "--new-session",
        "--bind",
        "/",
        "/",
        "--dev-bind",
        "/dev",
        "/dev",
    ]);
    if remap_temporary {
        command.arg("--bind").arg(temporary).arg("/tmp");
    }
    for (path, read_only, descriptor) in &mounts {
        command
            .arg(if *read_only {
                "--ro-bind-fd"
            } else {
                "--bind-fd"
            })
            .arg(descriptor.as_raw_fd().to_string())
            .arg(path);
    }
    let error = command
        .args(["--proc", "/proc", "--cap-drop", "ALL", "--"])
        .arg(executable)
        .arg("--sandbox-ipc-worker")
        .args(arguments)
        .env_remove("ARGV0")
        .exec();
    Err(error)
}

fn temporary_mounts() -> io::Result<Vec<(String, bool, File)>> {
    let mut mounts = Vec::new();
    for line in fs::read_to_string("/proc/self/mountinfo")?.lines() {
        let mut fields = line.split_whitespace();
        let mount_id = fields
            .next()
            .ok_or(io::ErrorKind::InvalidData)?
            .parse::<u64>()
            .map_err(|_| io::ErrorKind::InvalidData)?;
        let path = fields.nth(3).ok_or(io::ErrorKind::InvalidData)?;
        let flags = fields.next().ok_or(io::ErrorKind::InvalidData)?;
        if path.starts_with("/tmp/") {
            let path = path
                .replace("\\040", " ")
                .replace("\\011", "\t")
                .replace("\\012", "\n")
                .replace("\\134", "\\");
            match statx(
                CWD,
                path.as_str(),
                AtFlags::SYMLINK_NOFOLLOW,
                StatxFlags::MNT_ID,
            ) {
                Ok(metadata) if metadata.stx_mnt_id == mount_id => {}
                Ok(_) | Err(rustix::io::Errno::NOENT | rustix::io::Errno::ACCESS) => continue,
                Err(error) => return Err(error.into()),
            }
            mounts.push((path, flags.split(',').any(|flag| flag == "ro")));
        }
    }
    mounts.sort_by_key(|(path, _)| path.len());
    mounts
        .into_iter()
        .map(|(path, read_only)| {
            let descriptor = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_PATH)
                .open(&path)?;
            // SAFETY: The owned descriptor is valid. Bubblewrap consumes and closes these mount sources.
            if unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_SETFD, 0) } < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok((path, read_only, descriptor))
        })
        .collect()
}

pub fn execute(mut arguments: impl Iterator<Item = OsString>) -> io::Result<()> {
    let executable = arguments.next().ok_or(io::ErrorKind::InvalidInput)?;
    isolate()?;
    let error = Command::new(executable)
        .args(arguments)
        .env_remove("ARGV0")
        .env_remove("LEXORA_BUDDY_SANDBOX_BWRAP")
        .env_remove("LEXORA_BUDDY_SANDBOX_TMP")
        .exec();
    Err(error)
}

fn isolate() -> io::Result<()> {
    let ruleset = Ruleset {
        handled_access_fs: RESOLVE_UNIX,
        handled_access_net: 0,
        scoped: SCOPE_ABSTRACT_UNIX | SCOPE_SIGNAL,
    };
    // SAFETY: The kernel reads the initialized, correctly sized C layout during this call.
    let descriptor = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &ruleset,
            size_of::<Ruleset>(),
            0,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: The successful syscall returned a new owned descriptor.
    let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor as i32) };
    // SAFETY: PR_SET_NO_NEW_PRIVS takes a boolean and no pointers.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: The descriptor remains open for the duration of the syscall.
    if unsafe { libc::syscall(libc::SYS_landlock_restrict_self, descriptor.as_raw_fd(), 0) } < 0 {
        return Err(io::Error::last_os_error());
    }
    restrict_syscalls()
}

fn restrict_syscalls() -> io::Result<()> {
    #[cfg(target_arch = "x86_64")]
    const ARCH: u32 = 0xc000_003e;
    #[cfg(target_arch = "aarch64")]
    const ARCH: u32 = 0xc000_00b7;
    let statement = |code, k| libc::sock_filter {
        code,
        jt: 0,
        jf: 0,
        k,
    };
    let jump = |k, jt, jf| libc::sock_filter {
        code: EQUAL,
        jt,
        jf,
        k,
    };
    let denied = libc::SECCOMP_RET_ERRNO | libc::EPERM as u32;
    let mut filter = vec![
        statement(LOAD, std::mem::offset_of!(libc::seccomp_data, arch) as u32),
        jump(ARCH, 1, 0),
        statement(RETURN, libc::SECCOMP_RET_KILL_PROCESS),
        statement(LOAD, std::mem::offset_of!(libc::seccomp_data, nr) as u32),
    ];
    #[cfg(target_arch = "x86_64")]
    filter.extend([
        libc::sock_filter {
            code: (libc::BPF_JMP | libc::BPF_JSET | libc::BPF_K) as u16,
            jt: 0,
            jf: 1,
            k: 0x4000_0000,
        },
        statement(RETURN, libc::SECCOMP_RET_KILL_PROCESS),
    ]);
    for syscall in [
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
    ] {
        filter.extend([jump(syscall as u32, 0, 1), statement(RETURN, denied)]);
    }
    filter.extend([
        jump(libc::SYS_socket as u32, 0, 3),
        statement(LOAD, std::mem::offset_of!(libc::seccomp_data, args) as u32),
        jump(libc::AF_VSOCK as u32, 0, 1),
        statement(RETURN, denied),
        statement(RETURN, libc::SECCOMP_RET_ALLOW),
    ]);
    let program = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };
    // SAFETY: The kernel copies the valid instruction slice before the call returns.
    if unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
