use super::*;

fn set_directory_acl(path: &std::path::Path, descriptor: &LocalMemory) {
    use windows_sys::Win32::Security::{PROTECTED_DACL_SECURITY_INFORMATION, SetFileSecurityW};

    let name: Vec<u16> = path.to_str().unwrap().encode_utf16().chain([0]).collect();
    assert_ne!(
        // SAFETY: The NUL-terminated path and owned security descriptor remain live for this call.
        unsafe {
            SetFileSecurityW(
                name.as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor.0,
            )
        },
        0,
        "{}",
        std::io::Error::last_os_error()
    );
}

#[test]
fn application_storage_preserves_access_while_sandbox_storage_requires_private_permissions() {
    let fixture = tempfile::tempdir().unwrap();
    let path = fixture.path().join("existing");
    std::fs::create_dir(&path).unwrap();
    set_directory_acl(&path, &from_sddl("D:P(A;OICI;FA;;;WD)").unwrap());
    let sentinel = path.join("preserved.txt");
    std::fs::write(&sentinel, "existing data").unwrap();
    let paths = [path.to_str().unwrap().to_owned()];
    let request = serde_json::to_vec(&serde_json::json!({ "paths": paths })).unwrap();
    let mut output = Vec::new();
    crate::private_directories::run(request.as_slice(), &mut output).unwrap();
    assert_eq!(output, b"{\"ok\":true}");
    let failure = crate::private_directories::ensure(&paths).unwrap_err();
    assert_eq!(failure.operation, DirectoryOperation::ValidateAcl);
    assert_eq!(
        failure.acl.unwrap().principal,
        Some(DirectoryPrincipal::Everyone)
    );
    assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "existing data");
}

#[test]
fn application_storage_does_not_require_directory_listing_or_acl_reads() {
    let fixture = tempfile::tempdir().unwrap();
    let parent = fixture.path().join("parent");
    let child = parent.join("child");
    crate::private_directories::ensure(&[child.to_str().unwrap().to_owned()]).unwrap();
    let sentinel = child.join("preserved.txt");
    std::fs::write(&sentinel, "existing data").unwrap();
    let paths = [
        parent.to_str().unwrap().to_owned(),
        child.to_str().unwrap().to_owned(),
    ];
    let request = serde_json::to_vec(&serde_json::json!({ "paths": paths })).unwrap();
    let restore = PrivateSecurity::new().unwrap();
    let denied = from_sddl("D:P(D;;0x20000;;;OW)(D;;0x1;;;WD)(A;OICI;FA;;;WD)").unwrap();
    set_directory_acl(&parent, &denied);
    let mut output = Vec::new();
    let application = crate::private_directories::run(request.as_slice(), &mut output);
    let sandbox = crate::private_directories::ensure(&paths);
    let preserved = std::fs::read_to_string(&sentinel);
    set_directory_acl(&parent, &restore.descriptor);
    application.unwrap();
    assert_eq!(output, b"{\"ok\":true}");
    assert_eq!(
        sandbox.unwrap_err().operation,
        DirectoryOperation::OpenDirectory
    );
    assert_eq!(preserved.unwrap(), "existing data");
}

#[test]
fn freshly_created_policy_has_private_owner_and_inheritable_acl() {
    let security = PrivateSecurity::new().unwrap();
    assert_eq!(security.validate_descriptor(&security.descriptor), Ok(()));
}

#[test]
fn rejects_null_dacl_untrusted_owner_and_allow_ace_variants_not_in_contract() {
    let security = PrivateSecurity::new().unwrap();
    for sddl in [
        "O:SYD:NO_ACCESS_CONTROL",
        "O:WDD:P(A;;FA;;;SY)",
        "O:SYD:P(A;OICI;FA;;;CO)",
        "O:SYD:P(A;OICIIO;FA;;;CG)",
        "O:COD:P(A;OICIIO;FA;;;CO)",
        r#"O:SYD:P(XA;;FR;;;WD;(@User.Title=="PM"))"#,
    ] {
        let descriptor = from_sddl(sddl).unwrap_or_else(|error| panic!("{sddl}: {error}"));
        let failure = security.validate_descriptor(&descriptor).unwrap_err();
        assert_eq!(failure.code, DirectoryError::Unsafe, "{sddl}");
        assert_eq!(failure.operation, DirectoryOperation::ValidateAcl, "{sddl}");
        assert!(failure.acl.is_some(), "{sddl}");
    }
}

#[test]
fn creator_owner_inherit_only_template_does_not_grant_access_to_other_users() {
    let security = PrivateSecurity::new().unwrap();
    for sddl in [
        "O:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;FA;;;CO)",
        "O:BAD:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIIOID;FA;;;CO)",
    ] {
        assert_eq!(
            security.validate_descriptor(&from_sddl(sddl).unwrap()),
            Ok(()),
            "{sddl}"
        );
    }
}

#[test]
fn empty_acl_and_deny_entries_do_not_grant_untrusted_access() {
    let security = PrivateSecurity::new().unwrap();
    for sddl in ["O:SYD:P", "O:SYD:P(D;;FA;;;WD)(A;;FA;;;SY)(A;;FA;;;BA)"] {
        assert_eq!(
            security.validate_descriptor(&from_sddl(sddl).unwrap()),
            Ok(()),
            "{sddl}"
        );
    }
}

#[test]
fn existing_read_only_grants_are_accepted_for_any_principal() {
    let security = PrivateSecurity::new().unwrap();
    for sid in ["WD", "BU", "AU", "AC", "S-1-5-21-1-2-3-1001"] {
        for mask in [
            0,
            FILE_READ_ATTRIBUTES,
            READ_CONTROL,
            SYNCHRONIZE,
            METADATA_READ_ACCESS,
            0x120089,
            0x81,
            READ_ONLY_ACCESS,
        ] {
            for flags in ["", "OICI", "OICIIO", "OICIID"] {
                let sddl = format!("O:SYD:P(A;OICI;FA;;;SY)(A;{flags};{mask:#x};;;{sid})");
                assert_eq!(
                    security.validate_descriptor(&from_sddl(&sddl).unwrap()),
                    Ok(()),
                    "{sddl}"
                );
            }
        }
    }
}

#[test]
fn read_only_grants_do_not_hide_write_changes_or_unknown_rights() {
    let security = PrivateSecurity::new().unwrap();
    for bit in 0..32 {
        let access = 1_u32 << bit;
        if access & 0x1200a9 != 0 {
            continue;
        }
        for (flags, ace_flags) in [("", 0), ("OICI", 3), ("OICIIO", 11), ("OICIID", 19)] {
            let mask = access | READ_ONLY_ACCESS;
            let sddl = format!("O:SYD:P(A;OICI;FA;;;SY)(A;{flags};{mask:#x};;;WD)");
            assert_eq!(
                security.validate_descriptor(&from_sddl(&sddl).unwrap()),
                Err(DirectoryFailure::acl(DirectoryAclFailure {
                    reason: DirectoryAclReason::UntrustedAccess,
                    ace_index: Some(1),
                    ace_type: Some(0),
                    ace_flags: Some(ace_flags),
                    access_mask: Some(mask),
                    principal: Some(DirectoryPrincipal::Everyone),
                })),
                "{sddl}"
            );
        }
    }
}

#[test]
fn inheritable_read_execute_grants_are_allowed() {
    let security = PrivateSecurity::new().unwrap();
    let sddl = "O:SYD:P(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;WD)";
    assert_eq!(
        security.validate_descriptor(&from_sddl(sddl).unwrap()),
        Ok(()),
        "{sddl}"
    );
}

#[test]
fn rejection_diagnostics_classify_principals_without_serializing_sids() {
    let security = PrivateSecurity::new().unwrap();
    for (sid, principal) in [
        ("WD", "everyone"),
        ("BU", "builtin_users"),
        ("AU", "authenticated_users"),
        ("AC", "all_app_packages"),
        ("CO", "creator_owner"),
        ("S-1-5-21-1-2-3-1001", "other"),
    ] {
        let descriptor = from_sddl(&format!("O:SYD:P(A;OICIID;0x83;;;{sid})")).unwrap();
        let failure = security.validate_descriptor(&descriptor).unwrap_err();
        assert_eq!(
            serde_json::to_value(&failure).unwrap()["acl"],
            serde_json::json!({
                "reason": "untrusted_access", "aceIndex": 0, "aceType": 0,
                "aceFlags": 19, "accessMask": 131, "principal": principal,
            })
        );
        assert!(!serde_json::to_string(&failure).unwrap().contains("S-1-"));
    }
    for (sddl, reason) in [
        ("O:SYD:NO_ACCESS_CONTROL", DirectoryAclReason::NullDacl),
        ("O:WDD:P(A;;FA;;;SY)", DirectoryAclReason::OwnerUntrusted),
        (
            r#"O:SYD:P(XA;;FR;;;WD;(@User.Title=="PM"))"#,
            DirectoryAclReason::UnsupportedAce,
        ),
    ] {
        let failure = security
            .validate_descriptor(&from_sddl(sddl).unwrap())
            .unwrap_err();
        assert_eq!(failure.acl.unwrap().reason, reason, "{sddl}");
    }
}
