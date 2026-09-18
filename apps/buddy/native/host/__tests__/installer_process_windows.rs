#![cfg(windows)]

use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
};

const HELPER: &str = env!("CARGO_BIN_EXE_lexora-buddy-process-control");

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
    std::fs::copy(HELPER, &executable).unwrap();
    executable
}

fn probe(path: &Path) -> Output {
    Command::new(HELPER)
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
        let output = Command::new(HELPER).args(arguments).output().unwrap();
        assert_eq!(output.status.code(), Some(1), "{output:?}");
        let diagnostic: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(diagnostic["status"], "failed");
    }
}
