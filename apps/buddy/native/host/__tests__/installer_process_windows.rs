#![cfg(windows)]

use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
};

fn process_control() -> PathBuf {
    std::env::var_os("LEXORA_TEST_PROCESS_CONTROL").map_or_else(
        || PathBuf::from(env!("CARGO_BIN_EXE_lexora-buddy-process-control")),
        PathBuf::from,
    )
}

struct Running(Child);

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn executable(directory: &Path) -> PathBuf {
    std::fs::create_dir_all(directory).unwrap();
    let executable = directory.join("Lexora Buddy.exe");
    std::fs::copy(process_control(), &executable).unwrap();
    executable
}

fn probe(path: &Path) -> Output {
    Command::new(process_control())
        .arg("--check-running")
        .arg(path)
        .output()
        .unwrap()
}

fn start(executable: &Path) -> Running {
    Running(
        Command::new(executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

#[test]
fn service_launcher_preserves_redirected_core_output_and_full_exit_status() {
    let root = tempfile::tempdir().unwrap();
    let node =
        Command::new(std::env::var_os("LEXORA_TEST_NODE").unwrap_or_else(|| "node.exe".into()))
            .args(["-p", "process.execPath"])
            .output()
            .unwrap();
    assert!(node.status.success());
    let node = String::from_utf8(node.stdout).unwrap();
    let script = root.path().join("status.cjs");
    let config = root.path().join("launch.json");
    std::fs::write(
        &config,
        serde_json::to_vec(&serde_json::json!({
            "nodeExecutable": node.trim(), "coreEntry": script,
        }))
        .unwrap(),
    )
    .unwrap();
    let helper = process_control();
    for code in [0, 7, 0x1234, 0x8123_4567u32 as i32] {
        std::fs::write(
            &script,
            format!("require('node:fs').writeSync(2, 'core diagnostic'); process.exit({code})"),
        )
        .unwrap();
        let result = Command::new(&helper)
            .arg("--launch-service")
            .arg(&config)
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(code));
        assert_eq!(result.stderr, b"core diagnostic");
    }
}

#[test]
fn fresh_installation_without_an_executable_is_ready() {
    let root = tempfile::tempdir().unwrap();
    let output = probe(&root.path().join("未安装\\Lexora Buddy.exe"));
    assert!(output.status.success(), "{output:?}");
    let diagnostic: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(diagnostic["status"], "ready");
    assert!(diagnostic["elapsedMs"].is_number());
}

#[test]
fn running_installation_is_blocked_without_terminating_it_and_becomes_ready_after_exit() {
    let root = tempfile::tempdir().unwrap();
    let path = executable(&root.path().join("用户 Data"));
    let mut running = start(&path);
    let output = probe(&path);
    assert_eq!(output.status.code(), Some(32), "{output:?}");
    assert!(running.0.try_wait().unwrap().is_none());
    let uppercase = PathBuf::from(path.to_str().unwrap().to_uppercase());
    assert_eq!(probe(&uppercase).status.code(), Some(32));
    drop(running);
    assert!(probe(&path).status.success());
}

#[test]
fn another_installation_with_the_same_executable_name_does_not_block() {
    let root = tempfile::tempdir().unwrap();
    let existing = executable(&root.path().join("existing"));
    let target = executable(&root.path().join("target"));
    let mut running = start(&existing);
    let output = probe(&target);
    assert!(output.status.success(), "{output:?}");
    assert!(running.0.try_wait().unwrap().is_none());
}

#[test]
fn invalid_or_incomplete_probe_arguments_fail_closed() {
    for arguments in [
        vec!["--check-running"],
        vec!["--check-running", "relative.exe"],
        vec!["--check-running", "C:\\app.exe", "extra"],
        vec!["--check-running", "\\\\?\\C:\\app.exe"],
    ] {
        let output = Command::new(process_control())
            .args(arguments)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "{output:?}");
        let diagnostic: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(diagnostic["status"], "failed");
    }
}

fn ticks(child: &Child) -> u64 {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{Foundation::FILETIME, System::Threading::GetProcessTimes};

    let [mut start, mut exit, mut kernel, mut user] = [FILETIME::default(); 4];
    assert_ne!(
        // SAFETY: The fixture owns the child handle and all four FILETIME outputs.
        unsafe {
            GetProcessTimes(
                child.as_raw_handle(),
                &mut start,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        },
        0
    );
    (u64::from(start.dwHighDateTime) << 32) | u64::from(start.dwLowDateTime)
}

fn wait_helper(helper: &Path, pid: u32, executable: &Path, ticks: u64, timeout: u32) -> Child {
    use std::io::Write;
    let mut child = Command::new(helper)
        .arg("--wait-for-service-exit")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let request = serde_json::json!({"pid": pid, "executable": executable, "startIdentity": ticks.to_string(), "timeoutMs": timeout});
    child
        .stdin
        .take()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();
    child
}

#[track_caller]
fn wait_status(waiter: Child, code: i32, status: &str) {
    let output = waiter.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(code), "{output:?}");
    assert_eq!(std::str::from_utf8(&output.stdout).unwrap().trim(), status);
}

fn deny_new_process_handles(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Security::{
        ACL, ACL_REVISION, DACL_SECURITY_INFORMATION, InitializeAcl, InitializeSecurityDescriptor,
        SECURITY_DESCRIPTOR, SetKernelObjectSecurity, SetSecurityDescriptorDacl,
    };
    let mut acl = ACL::default();
    let mut descriptor = SECURITY_DESCRIPTOR::default();
    let descriptor = std::ptr::from_mut(&mut descriptor).cast();
    // SAFETY: The aligned ACL and descriptor remain live until the disposable child's DACL is set.
    unsafe {
        assert_ne!(
            InitializeAcl(&mut acl, size_of::<ACL>() as u32, ACL_REVISION),
            0
        );
        assert_ne!(InitializeSecurityDescriptor(descriptor, 1), 0);
        assert_ne!(SetSecurityDescriptorDacl(descriptor, 1, &acl, 0), 0);
        assert_ne!(
            SetKernelObjectSecurity(child.as_raw_handle(), DACL_SECURITY_INFORMATION, descriptor),
            0
        );
    }
}

#[test]
fn wait_for_exact_service_exit() {
    use std::time::{Duration, Instant};
    let helper = process_control();
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("测试 Core.exe");
    std::fs::copy(&helper, &path).unwrap();
    let mut core = start(&path);
    let pid = core.0.id();
    let start_ticks = ticks(&core.0);
    let wait = |exe, ticks, ms| wait_helper(&helper, pid, exe, ticks, ms);

    let start_time = Instant::now();
    wait_status(wait(&path, start_ticks, 100), 0, "timeout");
    assert!(start_time.elapsed() >= Duration::from_millis(80));
    wait_status(wait(&path, start_ticks - 1, 0), 0, "exited");
    wait_status(wait(&helper, start_ticks, 0), 1, "");
    assert!(core.0.try_wait().unwrap().is_none());

    let mut waiter = wait(&path, start_ticks, 5000);
    std::thread::sleep(Duration::from_millis(100));
    assert!(waiter.try_wait().unwrap().is_none());
    drop(core.0.stdin.take()); // The fixture exits on EOF without a termination request.
    wait_status(waiter, 0, "exited");
    core.0.wait().unwrap();
    wait_status(wait(&path, start_ticks, 0), 0, "exited");
    drop(core);
    wait_status(wait(&path, start_ticks, 0), 0, "exited");
}

#[test]
fn wait_for_service_exit_fails_when_process_access_is_denied() {
    use lexora_buddy_host::process_control::{ProcessError, wait_for_service_exit};
    use std::{
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr,
    };
    use windows_sys::Win32::{
        Security::{
            CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, ImpersonateLoggedOnUser, RevertToSelf,
            TOKEN_DUPLICATE, TOKEN_QUERY,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    let root = tempfile::tempdir().unwrap();
    let path = executable(root.path());
    let mut core = start(&path);
    let request = serde_json::to_vec(&serde_json::json!({
        "pid": core.0.id(), "executable": path, "startIdentity": ticks(&core.0).to_string(), "timeoutMs": 0,
    }))
    .unwrap();

    let mut token = ptr::null_mut();
    // SAFETY: Query and duplicate only the current process token; the output is writable.
    let opened = unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY,
            &mut token,
        )
    };
    assert_ne!(opened, 0, "{}", std::io::Error::last_os_error());
    // SAFETY: OpenProcessToken returned a new handle owned by this test.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut restricted = ptr::null_mut();
    // SAFETY: The token and output are valid; empty SID and privilege lists have null pointers.
    let created = unsafe {
        CreateRestrictedToken(
            token.as_raw_handle(),
            DISABLE_MAX_PRIVILEGE,
            0,
            ptr::null(),
            0,
            ptr::null(),
            0,
            ptr::null(),
            &mut restricted,
        )
    };
    assert_ne!(created, 0, "{}", std::io::Error::last_os_error());
    // SAFETY: CreateRestrictedToken returned a new handle owned by this test.
    let restricted = unsafe { OwnedHandle::from_raw_handle(restricted) };

    // An elevated runner's SeDebugPrivilege can bypass the fixture's process DACL.
    // SAFETY: The same-user restricted token stays live through the wait and is then reverted.
    let impersonated = unsafe { ImpersonateLoggedOnUser(restricted.as_raw_handle()) };
    assert_ne!(impersonated, 0, "{}", std::io::Error::last_os_error());
    let before = wait_for_service_exit(request.as_slice());
    deny_new_process_handles(&core.0);
    let after = wait_for_service_exit(request.as_slice());
    // SAFETY: Revert the impersonation established on this test thread above.
    let reverted = unsafe { RevertToSelf() };
    assert_ne!(reverted, 0, "{}", std::io::Error::last_os_error());

    assert_eq!(before, Ok(false));
    assert_eq!(after, Err(ProcessError::Failed));
    assert!(core.0.try_wait().unwrap().is_none());
}

#[test]
fn application_start_is_blocked_only_while_the_installer_owns_its_mutex() {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{CreateMutexW, ReleaseMutex},
    };
    let name: Vec<u16> = lexora_buddy_host::installation_gate::MUTEX_NAME
        .encode_utf16()
        .chain([0])
        .collect();
    // SAFETY: The NUL-terminated name is live and this test owns the new mutex.
    let mutex = unsafe { CreateMutexW(ptr::null(), 1, name.as_ptr()) };
    assert!(!mutex.is_null());
    let output = Command::new(process_control())
        .arg("--check-installation")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(32));
    // SAFETY: This test owns the mutex; the final handle is closed after its release.
    unsafe {
        ReleaseMutex(mutex);
        CloseHandle(mutex);
    }
    let output = Command::new(process_control())
        .arg("--check-installation")
        .output()
        .unwrap();
    assert!(output.status.success());
}
