#![cfg(target_os = "linux")]

use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, Command, Stdio},
};

fn private_root() -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    root
}

struct Execution {
    child: Child,
    control: BufReader<std::process::ChildStderr>,
    identity: Value,
    launch: Value,
}

impl Execution {
    fn new(root: &Path) -> Self {
        let launch = json!({
            "executionId": uuid::Uuid::new_v4().to_string(),
            "dispatchId": uuid::Uuid::new_v4().to_string(),
            "receiptDirectory": root,
        });
        let mut child = spawn(&launch);
        let mut control = BufReader::new(child.stderr.take().unwrap());
        let mut line = String::new();
        control.read_line(&mut line).unwrap();
        let ready: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(ready["protocol"], 2, "{ready}");
        Self {
            child,
            control,
            identity: ready["identity"].clone(),
            launch,
        }
    }

    fn start(&mut self, command: &str) {
        let request = json!({
            "shell": "/bin/bash", "args": ["--noprofile", "--norc", "-c"],
            "command": command, "commandTransport": "argv", "cwd": "/tmp",
            "environment": {"PATH": "/usr/bin:/bin"},
            "executionId": self.launch["executionId"], "dispatchId": self.launch["dispatchId"],
        });
        writeln!(self.child.stdin.as_mut().unwrap(), "{request}").unwrap();
    }

    fn dispatch(&self) -> Value {
        json!({"kind":"native-shell-dispatch","platform":"linux","version":3,
            "executionId":self.launch["executionId"],"dispatchId":self.launch["dispatchId"]})
    }

    fn wait(&mut self) {
        self.child.wait().unwrap();
        let mut remaining = String::new();
        std::io::Read::read_to_string(&mut self.control, &mut remaining).unwrap();
    }
}

impl Drop for Execution {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn(launch: &Value) -> Child {
    Command::new(env!("CARGO_BIN_EXE_lexora-buddy-process-control"))
        .args(["--supervise-shell", &launch.to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn verify(identity: Value, root: &Path) -> Value {
    let mut query = Command::new(env!("CARGO_BIN_EXE_lexora-buddy-process-control"))
        .arg("--reverify-owned-process")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    serde_json::to_writer(
        query.stdin.take().unwrap(),
        &json!({"identity":identity,"receiptDirectory":root}),
    )
    .unwrap();
    let output = query.wait_with_output().unwrap();
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn closed_gate_has_a_durable_receipt_even_when_ready_was_not_persisted_by_the_caller() {
    let root = private_root();
    let mut execution = Execution::new(root.path());
    assert_eq!(
        verify(execution.dispatch(), root.path())["status"],
        "active"
    );
    drop(execution.child.stdin.take());
    execution.wait();
    assert_eq!(
        verify(execution.dispatch(), root.path())["reason"],
        "supervisor_receipt"
    );
}

#[test]
fn receipt_survives_supervisor_exit_and_proves_detached_descendants_were_reaped() {
    let root = private_root();
    let mut execution = Execution::new(root.path());
    execution.start("setsid sh -c 'sleep 60 >/dev/null 2>&1 & echo $!' & wait");
    let mut output = String::new();
    std::io::Read::read_to_string(&mut execution.child.stdout.take().unwrap(), &mut output)
        .unwrap();
    execution.wait();
    let pid: u32 = output.trim().parse().unwrap();
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
    assert_eq!(
        verify(execution.dispatch(), root.path())["status"],
        "released"
    );
    let mut identity = execution.identity.clone();
    identity["kind"] = json!("native-shell");
    identity["platform"] = json!("linux");
    assert_eq!(
        verify(identity.clone(), root.path())["reason"],
        "supervisor_receipt"
    );
    identity["startTime"] = json!("0");
    assert_eq!(verify(identity, root.path())["reason"], "receipt_invalid");
}

#[test]
fn malformed_receipt_owner_is_never_release_evidence() {
    use std::os::unix::fs::PermissionsExt;
    let root = private_root();
    let mut execution = Execution::new(root.path());
    drop(execution.child.stdin.take());
    execution.wait();
    let mut invalid_owners = vec![json!({
        "executionId": execution.launch["executionId"],
        "dispatchId": execution.launch["dispatchId"],
    })];
    for (key, value) in [
        ("version", json!(99)),
        ("pid", json!(0)),
        ("startTime", json!("invalid")),
        ("bootId", json!("invalid")),
        ("jobName", json!("unexpected")),
    ] {
        let mut identity = execution.identity.clone();
        identity[key] = value;
        invalid_owners.push(identity);
    }
    for identity in invalid_owners {
        for (phase, closed) in [("prepared", false), ("released", true)] {
            let file = root.path().join(format!(
                "{}.{}.json",
                execution.launch["executionId"].as_str().unwrap(),
                phase
            ));
            std::fs::write(
                &file,
                json!({"version":1, "identity":identity, "launchClosed":closed}).to_string(),
            )
            .unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(
            verify(execution.dispatch(), root.path())["reason"],
            "receipt_invalid"
        );
    }
}

#[test]
fn duplicate_execution_never_enters_the_command_gate() {
    let root = private_root();
    let mut execution = Execution::new(root.path());
    drop(execution.child.stdin.take());
    execution.wait();
    let output = spawn(&execution.launch).wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(
        !String::from_utf8(output.stderr)
            .unwrap()
            .contains("\"type\":\"ready\"")
    );
}

#[test]
fn killed_owner_without_a_receipt_stays_unknown() {
    let root = private_root();
    let mut execution = Execution::new(root.path());
    execution.child.kill().unwrap();
    execution.wait();
    assert_eq!(
        verify(execution.dispatch(), root.path())["reason"],
        "descendants_unverified"
    );
}

#[test]
fn malformed_or_missing_receipt_cannot_prove_release() {
    let root = private_root();
    let other = private_root();
    let mut execution = Execution::new(root.path());
    drop(execution.child.stdin.take());
    execution.wait();
    assert_eq!(
        verify(execution.dispatch(), other.path())["reason"],
        "receipt_missing"
    );
    let released = root.path().join(format!(
        "{}.released.json",
        execution.launch["executionId"].as_str().unwrap()
    ));
    std::fs::write(released, b"{").unwrap();
    assert_eq!(
        verify(execution.dispatch(), root.path())["reason"],
        "receipt_invalid"
    );
}

#[test]
fn permissive_or_symlinked_receipt_root_is_rejected_before_ready() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = private_root();
    let mut launch = json!({"executionId":uuid::Uuid::new_v4().to_string(),"dispatchId":uuid::Uuid::new_v4().to_string(),"receiptDirectory":root.path()});
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!spawn(&launch).wait_with_output().unwrap().status.success());
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let links = private_root();
    let link = links.path().join("link");
    symlink(root.path(), &link).unwrap();
    launch["receiptDirectory"] = json!(link);
    assert!(!spawn(&launch).wait_with_output().unwrap().status.success());
}
