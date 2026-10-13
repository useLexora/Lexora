#![cfg(target_os = "linux")]

use std::{
    io::{Read, Write},
    os::{
        linux::net::SocketAddrExt,
        unix::{
            net::{SocketAddr, UnixDatagram, UnixListener, UnixStream},
            process::CommandExt,
        },
    },
    process::{Command, Output},
    time::{Duration, Instant},
};

const HELPER: &str = env!("CARGO_BIN_EXE_lexora-buddy-process-control");
const CASE: &str = "LEXORA_IPC_TEST_CASE";

fn supported() -> bool {
    let output = Command::new(HELPER)
        .arg("--probe-sandbox-ipc")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["privateUnixSockets"]
        == true
}

fn child(case: &str) -> Command {
    let mut command = Command::new(HELPER);
    command
        .arg("--sandbox-ipc-worker")
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", case, "--nocapture", "--test-threads=1"])
        .env(CASE, case);
    command
}

fn assert_success(output: Output) {
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn private_ipc_is_inherited_but_host_stream_datagram_abstract_and_signal_access_is_denied() {
    let case =
        "private_ipc_is_inherited_but_host_stream_datagram_abstract_and_signal_access_is_denied";
    if std::env::var(CASE).as_deref() == Ok("client") {
        let mut stream =
            UnixStream::connect(std::env::var_os("LEXORA_PRIVATE_SOCKET").unwrap()).unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).unwrap();
        assert_eq!(reply, "private-reply");
        return;
    }
    if std::env::var(CASE).as_deref() == Ok(case) {
        let host = std::env::var("LEXORA_HOST_SOCKET").unwrap();
        assert_eq!(
            UnixStream::connect(&host).unwrap_err().raw_os_error(),
            Some(libc::EACCES)
        );
        let abstract_address =
            SocketAddr::from_abstract_name(std::env::var("LEXORA_HOST_ABSTRACT").unwrap()).unwrap();
        assert_eq!(
            UnixStream::connect_addr(&abstract_address)
                .unwrap_err()
                .raw_os_error(),
            Some(libc::EPERM)
        );
        assert_eq!(
            UnixDatagram::unbound()
                .unwrap()
                .send_to(b"blocked", format!("{host}.datagram"))
                .unwrap_err()
                .raw_os_error(),
            Some(libc::EACCES)
        );
        let host_pid: i32 = std::env::var("LEXORA_HOST_PID").unwrap().parse().unwrap();
        // SAFETY: SIGCONT is harmless even if the expected denial regresses.
        assert_eq!(unsafe { libc::kill(host_pid, libc::SIGCONT) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EPERM)
        );
        let directory = tempfile::tempdir().unwrap();
        let private = directory.path().join("private.sock");
        let listener = UnixListener::bind(&private).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut client = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", case, "--nocapture", "--test-threads=1"])
            .env(CASE, "client")
            .env("LEXORA_PRIVATE_SOCKET", &private)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(connection) => break connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "private IPC client did not connect"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("private IPC listener failed: {error}"),
            }
        };
        stream.write_all(b"private-reply").unwrap();
        drop(stream);
        assert!(client.wait().unwrap().success());
        let address =
            SocketAddr::from_abstract_name(format!("lexora-private-{}", std::process::id()))
                .unwrap();
        let listener = UnixListener::bind_addr(&address).unwrap();
        let _stream = UnixStream::connect_addr(&address).unwrap();
        listener.accept().unwrap();
        return;
    }
    if !supported() {
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let host = directory.path().join("host.sock");
    let _stream = UnixListener::bind(&host).unwrap();
    let _datagram = UnixDatagram::bind(directory.path().join("host.sock.datagram")).unwrap();
    let name = format!("lexora-host-{}", std::process::id());
    let _abstract =
        UnixListener::bind_addr(&SocketAddr::from_abstract_name(&name).unwrap()).unwrap();
    assert_success(
        child(case)
            .env("LEXORA_HOST_SOCKET", &host)
            .env("LEXORA_HOST_ABSTRACT", name)
            .env("LEXORA_HOST_PID", std::process::id().to_string())
            .output()
            .unwrap(),
    );
}

#[test]
fn private_socketpairs_work_while_vsock_and_io_uring_are_denied() {
    let case = "private_socketpairs_work_while_vsock_and_io_uring_are_denied";
    if std::env::var(CASE).as_deref() == Ok(case) {
        let (mut left, mut right) = UnixStream::pair().unwrap();
        left.write_all(b"ipc").unwrap();
        let mut reply = [0; 3];
        right.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"ipc");
        // SAFETY: These calls are denied before their unused arguments can be dereferenced.
        let socket = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM, 0) };
        assert_eq!(socket, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EPERM)
        );
        for syscall in [
            libc::SYS_io_uring_setup,
            libc::SYS_io_uring_enter,
            libc::SYS_io_uring_register,
        ] {
            // SAFETY: Null arguments contain no borrowed memory and must not be accessed by the filter.
            assert_eq!(unsafe { libc::syscall(syscall, 0, 0, 0, 0, 0, 0) }, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EPERM)
            );
        }
        return;
    }
    if supported() {
        assert_success(child(case).output().unwrap());
    }
}

#[test]
fn failed_isolation_never_executes_the_workload() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("must-not-run");
    let mut command = Command::new(HELPER);
    command
        .args(["--sandbox-ipc-worker", "/usr/bin/touch"])
        .arg(&marker);
    // SAFETY: The pre-exec closure only runs async-signal-safe syscalls with stack-owned data.
    unsafe {
        command.pre_exec(|| {
            let mut filter = [
                libc::sock_filter {
                    code: 0x20,
                    jt: 0,
                    jf: 0,
                    k: 0,
                },
                libc::sock_filter {
                    code: 0x15,
                    jt: 0,
                    jf: 1,
                    k: libc::SYS_landlock_restrict_self as u32,
                },
                libc::sock_filter {
                    code: 0x06,
                    jt: 0,
                    jf: 0,
                    k: libc::SECCOMP_RET_ERRNO | libc::EPERM as u32,
                },
                libc::sock_filter {
                    code: 0x06,
                    jt: 0,
                    jf: 0,
                    k: libc::SECCOMP_RET_ALLOW,
                },
            ];
            let program = libc::sock_fprog {
                len: filter.len() as u16,
                filter: filter.as_mut_ptr(),
            };
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0
                || libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) < 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = command.output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("SANDBOX_IPC_ISOLATION_FAILED"));
    assert!(!marker.exists());
}
