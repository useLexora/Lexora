#![cfg(target_os = "macos")]

#[test]
fn reads_stable_identity_and_refuses_exited_processes() {
    let mut child = std::process::Command::new("/bin/sleep")
        .arg("20")
        .spawn()
        .unwrap();
    let request = serde_json::to_vec(
        &serde_json::json!({ "operation": "read", "pid": child.id(), "protectedPids": [] }),
    )
    .unwrap();
    let mut first = Vec::new();
    lexora_buddy_host::process_control::run(request.as_slice(), &mut first).unwrap();
    let mut second = Vec::new();
    lexora_buddy_host::process_control::run(request.as_slice(), &mut second).unwrap();
    assert_eq!(first, second);
    let identity: serde_json::Value = serde_json::from_slice(&first).unwrap();
    assert_eq!(identity[0]["pid"], child.id());
    assert!(
        identity[0]["instanceId"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            > 0
    );
    child.kill().unwrap();
    child.wait().unwrap();
    let mut exited = Vec::new();
    lexora_buddy_host::process_control::run(request.as_slice(), &mut exited).unwrap();
    assert_eq!(exited, b"[]");
}
