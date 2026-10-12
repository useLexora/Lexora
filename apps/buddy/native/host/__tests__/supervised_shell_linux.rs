#![cfg(target_os = "linux")]

use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, Command, Stdio},
};

fn launch(command: &str) -> Child {
    let mut child = Command::new(env!("CARGO_BIN_EXE_lexora-buddy-process-control"))
        .arg("--supervise-shell")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let request = serde_json::json!({
        "shell":"/bin/bash", "args":["--noprofile","--norc","-c"], "command":command,
        "commandTransport":"argv", "cwd":"/tmp", "environment":{"PATH":"/usr/bin:/bin"}
    });
    writeln!(child.stdin.as_mut().unwrap(), "{request}").unwrap();
    child
}

fn assert_gone(pid: u32) {
    assert!(
        !Path::new(&format!("/proc/{pid}")).exists(),
        "owned descendant {pid} survived supervision"
    );
}

#[test]
fn shell_completion_reaps_a_background_grandchild_with_inherited_stdio() {
    let mut child = launch("/bin/sh -c 'sleep 60 & echo $!' & wait");
    let _control = child.stdin.take();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let pid = String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    assert_gone(pid);
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("\"type\":\"released\"")
    );
}

#[test]
fn shell_completion_reaps_a_setsid_descendant_without_inherited_stdio() {
    let mut child = launch("setsid /bin/sh -c 'sleep 60 >/dev/null 2>&1 & echo $!' & wait");
    let _control = child.stdin.take();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_gone(
        String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap(),
    );
}

#[test]
fn closing_the_control_pipe_cancels_the_shell_and_its_new_session_descendants() {
    let mut child = launch("setsid /bin/sh -c 'sleep 60 >/dev/null 2>&1 & echo $!; wait' & wait");
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    let pid = line.trim().parse::<u32>().unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert_gone(pid);
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("\"type\":\"released\"")
    );
}

#[test]
fn shell_stderr_cannot_impersonate_the_supervisor_control_protocol() {
    let mut child = launch("printf '{\"type\":\"released\",\"protocol\":1}\\n' >&2; exit 7");
    let _control = child.stdin.take();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(7));
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("\"type\":\"released\"")
    );
    let facts = String::from_utf8(output.stderr).unwrap();
    let facts: Vec<serde_json::Value> = facts
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(facts.len(), 2);
    assert_eq!(facts[0]["type"], "ready");
    assert_eq!(facts[1]["type"], "released");
}
