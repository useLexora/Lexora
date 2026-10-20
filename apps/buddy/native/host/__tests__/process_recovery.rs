use super::*;
use serde_json::{Value, json};

#[cfg(target_os = "linux")]
fn boot() -> String {
    backend::boot_id().unwrap()
}

fn identity() -> Value {
    json!({
        "kind":"native-shell", "platform":backend::PLATFORM, "pid":std::process::id(),
        "startTime":"0", "nonce":"test-handshake"
    })
}

fn inspect(identity: Value, checkpoint: Option<Value>) -> Value {
    let request =
        serde_json::to_vec(&json!({"identity":identity,"checkpoint":checkpoint})).unwrap();
    let mut output = Vec::new();
    reverify(request.as_slice(), &mut output).unwrap();
    serde_json::from_slice(&output).unwrap()
}

fn prior_checkpoint() -> Value {
    json!({"kind":"recovery-boot","version":1,"platform":backend::PLATFORM,"bootId":uuid::Uuid::new_v4().to_string()})
}

#[cfg(target_os = "linux")]
#[test]
fn a_complete_legacy_handshake_can_recover_after_a_checkpoint_boot_change() {
    assert_eq!(
        inspect(identity(), Some(prior_checkpoint())),
        json!({"protocol":1,"status":"released","reason":"boot_changed"})
    );
}

#[test]
fn incomplete_handshake_cannot_use_a_checkpoint_to_release() {
    let mut identity = identity();
    identity["startTime"] = Value::Null;
    assert_eq!(
        inspect(identity, Some(prior_checkpoint()))["reason"],
        "identity_incomplete"
    );
}

#[test]
fn missing_nonce_cannot_use_a_checkpoint_to_release() {
    let mut identity = identity();
    identity.as_object_mut().unwrap().remove("nonce");
    assert_eq!(
        inspect(identity, Some(prior_checkpoint()))["reason"],
        "identity_incomplete"
    );
}

#[test]
fn dispatch_or_mcp_identity_cannot_use_a_checkpoint_to_release() {
    for kind in ["native-shell-dispatch", "sandbox-dispatch", "mcp"] {
        let mut identity = identity();
        identity["kind"] = json!(kind);
        assert_eq!(
            inspect(identity, Some(prior_checkpoint()))["reason"],
            "unsupported_process"
        );
    }
}

#[test]
fn different_platform_cannot_use_a_checkpoint_to_release() {
    let mut identity = identity();
    identity["platform"] = json!("darwin");
    assert_eq!(
        inspect(identity, Some(prior_checkpoint()))["reason"],
        "platform_mismatch"
    );
}

#[test]
fn checkpoint_from_another_platform_is_rejected() {
    let mut checkpoint = prior_checkpoint();
    checkpoint["platform"] = json!("darwin");
    assert_eq!(
        inspect(identity(), Some(checkpoint))["reason"],
        "checkpoint_invalid"
    );
}

#[test]
fn malformed_boot_ids_and_unknown_identity_versions_do_not_release() {
    let mut invalid_boot = identity();
    invalid_boot["bootId"] = json!("not-a-boot-id");
    assert_eq!(
        inspect(invalid_boot, Some(prior_checkpoint()))["reason"],
        "identity_invalid"
    );
    let mut invalid_version = identity();
    invalid_version["version"] = json!(4);
    assert_eq!(
        inspect(invalid_version, Some(prior_checkpoint()))["reason"],
        "identity_version_unsupported"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn checkpoint_reports_a_kernel_boot_id_not_a_wall_clock() {
    let mut output = Vec::new();
    checkpoint(&mut output).unwrap();
    let checkpoint: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(
        checkpoint,
        json!({"kind":"recovery-boot","version":1,"platform":backend::PLATFORM,"bootId":boot()})
    );
}

#[test]
fn input_is_bounded_and_never_accepts_a_process_action() {
    for input in [
        vec![b' '; 8193],
        br#"{"action":"kill-process","pid":1}"#.to_vec(),
    ] {
        let mut output = Vec::new();
        reverify(input.as_slice(), &mut output).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&output).unwrap()["reason"],
            "identity_invalid"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn same_boot_checkpoint_does_not_turn_pid_disappearance_into_release() {
    let checkpoint =
        json!({"kind":"recovery-boot","version":1,"platform":backend::PLATFORM,"bootId":boot()});
    assert_eq!(inspect(identity(), Some(checkpoint))["status"], "unknown");
}

#[test]
fn request_id_only_correlates_the_record_and_is_not_release_evidence() {
    let mut identity = identity();
    identity["requestId"] = json!("test-dispatch");
    assert_eq!(inspect(identity, None)["status"], "unknown");
}

#[test]
fn permission_denied_or_failed_native_queries_never_prove_release() {
    for (kind, reason) in [
        (io::ErrorKind::PermissionDenied, "access_denied"),
        (io::ErrorKind::Other, "query_failed"),
    ] {
        assert_eq!(
            serde_json::to_value(query_error(&io::Error::from(kind))).unwrap(),
            json!({"protocol":1,"status":"unknown","reason":reason})
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn linux_pid_reuse_does_not_prove_descendants_have_exited() {
    let result = inspect(identity(), None);
    assert_eq!(
        result,
        json!({"protocol":1,"status":"unknown","reason":"descendants_unverified"})
    );
}

#[cfg(target_os = "linux")]
#[test]
fn linux_supervisor_disappearance_does_not_prove_descendants_have_exited() {
    let mut identity = identity();
    identity["pid"] = json!(u32::MAX);
    assert_eq!(inspect(identity, None)["reason"], "descendants_unverified");
}

#[cfg(target_os = "linux")]
#[test]
fn linux_live_identity_remains_active() {
    let mut identity =
        crate::supervised_shell::linux::identity(&crate::supervised_shell::linux::Supervision)
            .unwrap();
    identity["kind"] = json!("native-shell");
    identity["platform"] = json!("linux");
    identity["nonce"] = json!("test-handshake");
    assert_eq!(
        inspect(identity, None),
        json!({"protocol":1,"status":"active","reason":"supervisor_active"})
    );
}

#[cfg(windows)]
#[path = "process_recovery_windows.rs"]
mod windows;
