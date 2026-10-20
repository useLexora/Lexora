use super::*;

fn evidence(sequence: u32, uptime: u64) -> Evidence {
    Evidence {
        source: "windows-boot-sequence".into(),
        version: 1,
        architecture: "x64".into(),
        build: 26100,
        sequence,
        uptime_millis: uptime.to_string(),
    }
}

#[test]
fn boot_attempt_without_kernel_uptime_reset_is_not_release_evidence() {
    assert!(!evidence(2, 5000).proves_restart_from(&evidence(1, 4000)));
    assert!(!evidence(2, 4000).proves_restart_from(&evidence(1, 4000)));
    assert!(!evidence(1, 3000).proves_restart_from(&evidence(1, 4000)));
}

#[test]
fn only_a_supported_same_build_sequence_change_with_lower_uptime_proves_restart() {
    assert!(evidence(2, 3000).proves_restart_from(&evidence(1, 4000)));
    let mut previous = evidence(1, 4000);
    previous.build = 22631;
    assert!(!evidence(2, 3000).proves_restart_from(&previous));
    previous.build = 99999;
    assert!(!evidence(2, 3000).proves_restart_from(&previous));
}

#[test]
fn malformed_or_differently_versioned_evidence_is_not_accepted() {
    let mut previous = evidence(1, 4000);
    previous.uptime_millis = "-1".into();
    assert!(!evidence(2, 3000).proves_restart_from(&previous));
    previous = evidence(1, 4000);
    previous.version = 2;
    assert!(!evidence(2, 3000).proves_restart_from(&previous));
}

#[test]
fn shared_page_layout_rejects_unrecognized_os_and_builds() {
    let mut bytes = [0; 0x2c8];
    assert!(decode(&bytes).is_err());
    bytes[0x26c..0x270].copy_from_slice(&10u32.to_le_bytes());
    bytes[0x260..0x264].copy_from_slice(&26100u32.to_le_bytes());
    bytes[0x2c4..0x2c8].copy_from_slice(&2u32.to_le_bytes());
    assert_eq!(decode(&bytes).unwrap(), (26100, 2));
    bytes[0x260..0x264].copy_from_slice(&99999u32.to_le_bytes());
    assert!(decode(&bytes).is_err());
}
