#![cfg(unix)]
use std::{fs, os::unix::fs::PermissionsExt, process::Command};

#[test]
fn service_launch_clears_injection_and_provider_environment_before_the_runtime() {
    let root = tempfile::tempdir().unwrap();
    let entry = root.path().join("runtime.sh");
    fs::write(&entry, "test -z \"$NODE_OPTIONS$NODE_PATH$ELECTRON_RUN_AS_NODE$OPENAI_API_KEY$LD_PRELOAD\" || exit 11\ntest \"$1\" = --config || exit 12\nprintf ready\n").unwrap();
    let config = root.path().join("launch.json");
    fs::write(
        &config,
        serde_json::to_vec(&serde_json::json!({ "nodeExecutable": "/bin/sh", "coreEntry": entry }))
            .unwrap(),
    )
    .unwrap();
    fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_lexora-buddy-process-control"))
        .arg("--launch-service")
        .arg(&config)
        .env("NODE_OPTIONS", "--import=invalid")
        .env("NODE_PATH", "invalid")
        .env("ELECTRON_RUN_AS_NODE", "1")
        .env("OPENAI_API_KEY", "fixture-secret")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(result.stdout, b"ready");
    fs::set_permissions(&config, fs::Permissions::from_mode(0o644)).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_lexora-buddy-process-control"))
        .arg("--launch-service")
        .arg(&config)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
}
