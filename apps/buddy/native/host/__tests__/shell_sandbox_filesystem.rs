use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::GetKernelObjectSecurity;

use super::*;

fn temporary_directory() -> tempfile::TempDir {
    let canonical = fs::canonicalize(std::env::temp_dir()).unwrap();
    let path = canonical.to_str().unwrap().strip_prefix(r"\\?\").unwrap();
    tempfile::tempdir_in(path).unwrap()
}

fn snapshot(file: &File) -> String {
    let mut storage = vec![0usize; 16384];
    let mut needed = 0;
    // SAFETY: The aligned buffer has its declared byte capacity and the fixture handle is live.
    boolean(unsafe {
        GetKernelObjectSecurity(
            file.as_raw_handle(),
            DACL_SECURITY_INFORMATION,
            storage.as_mut_ptr().cast(),
            (storage.len() * size_of::<usize>()) as u32,
            &mut needed,
        )
    })
    .unwrap();
    let mut text = ptr::null_mut();
    let mut length = 0;
    // SAFETY: The API receives a live descriptor and returns an owned, length-delimited UTF-16 string.
    boolean(unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            storage.as_mut_ptr().cast(),
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut text,
            &mut length,
        )
    })
    .unwrap();
    let _text = LocalMemory(text.cast());
    // SAFETY: The returned buffer has the declared length and remains live during this bounded scan.
    let units = unsafe { std::slice::from_raw_parts(text, length as usize) };
    let end = units.iter().position(|unit| *unit == 0).unwrap();
    String::from_utf16(&units[..end]).unwrap()
}

#[test]
fn temporary_grants_preserve_legacy_explicit_entries_matching_the_parent() {
    let directory = temporary_directory();
    let parent = open_path(directory.path().to_str().unwrap()).unwrap();
    let user = sid_text(&process_user_sid(current_process()).unwrap()).unwrap();
    let legacy = format!("D:(A;OICI;FA;;;{user})");
    let descriptor = SecurityDescriptor::new(&legacy).unwrap();
    let child_path = directory.path().join("child");
    // SAFETY: Only the synthetic parent and child receive this fixture-owned descriptor.
    unsafe {
        boolean(SetKernelObjectSecurity(
            parent.as_raw_handle(),
            DACL_SECURITY_INFORMATION,
            descriptor.as_ptr(),
        ))
        .unwrap();
    }
    fs::create_dir(&child_path).unwrap();
    let child = open_path(child_path.to_str().unwrap()).unwrap();
    // SAFETY: The live child belongs exclusively to this fixture.
    unsafe {
        boolean(SetKernelObjectSecurity(
            child.as_raw_handle(),
            DACL_SECURITY_INFORMATION,
            descriptor.as_ptr(),
        ))
        .unwrap();
    }
    let original = snapshot(&parent);
    assert_eq!(snapshot(&child), original);
    let profile = Profile::create().unwrap();
    change_acl(&child, &profile.sid, FILE_GENERIC_READ, GRANT_ACCESS, true).unwrap();
    change_acl(&child, &profile.sid, 0, REVOKE_ACCESS, false).unwrap();
    assert_eq!(snapshot(&child), original);
    assert_eq!(snapshot(&parent), original);
}

#[test]
fn temporary_grants_preserve_inheritance_control_without_propagating_to_children() {
    let directory = temporary_directory();
    let root = open_path(directory.path().to_str().unwrap()).unwrap();
    let user = sid_text(&process_user_sid(current_process()).unwrap()).unwrap();
    let descriptor = SecurityDescriptor::new(&format!("D:PAI(A;OICI;FA;;;{user})")).unwrap();
    // SAFETY: The descriptor is private to this synthetic directory; no system or user ACL is changed.
    unsafe {
        boolean(SetSecurityDescriptorControl(
            descriptor.as_ptr(),
            SE_DACL_AUTO_INHERIT_REQ,
            SE_DACL_AUTO_INHERIT_REQ,
        ))
        .unwrap();
        boolean(SetKernelObjectSecurity(
            root.as_raw_handle(),
            DACL_SECURITY_INFORMATION,
            descriptor.as_ptr(),
        ))
        .unwrap();
    }
    let before = snapshot(&root);
    assert!(before.starts_with("D:PAI"), "{before}");
    let child_path = directory.path().join("child");
    fs::create_dir(&child_path).unwrap();
    let child = open_path(child_path.to_str().unwrap()).unwrap();
    let child_before = snapshot(&child);
    let profile = Profile::create().unwrap();
    change_acl(&root, &profile.sid, FILE_GENERIC_READ, GRANT_ACCESS, true).unwrap();
    assert!(snapshot(&root).starts_with("D:PAI"));
    assert_eq!(snapshot(&child), child_before);
    change_acl(&root, &profile.sid, 0, REVOKE_ACCESS, false).unwrap();
    assert_eq!(snapshot(&root), before);
    assert_eq!(snapshot(&child), child_before);
}

#[test]
fn noninheriting_probe_grants_do_not_propagate_existing_parent_entries() {
    let directory = temporary_directory();
    let path = directory.path().to_str().unwrap();
    let root = open_path(path).unwrap();
    let child_path = directory.path().join("child");
    fs::create_dir(&child_path).unwrap();
    let child = open_path(child_path.to_str().unwrap()).unwrap();
    let before = snapshot(&child);
    let pending = Profile::create().unwrap();
    change_acl(&root, &pending.sid, FILE_GENERIC_READ, GRANT_ACCESS, true).unwrap();
    let profile = Profile::create().unwrap();
    let mut grant = inspect(path, Access::Read).unwrap();
    grant.inherit = false;
    let (_input, cancellation) = pending_cancellation(std::time::Duration::from_secs(30));
    ensure_acl(
        &grant,
        &root,
        &profile.sid,
        FILE_GENERIC_READ,
        GRANT_ACCESS,
        &cancellation,
    )
    .unwrap();
    assert_eq!(snapshot(&child), before);
}

fn sid_entries(file: &File, sid: &Sid, deny: bool) -> Vec<(u32, u32)> {
    use windows_sys::Win32::Security::{ACCESS_ALLOWED_ACE, ACE_HEADER, EqualSid, GetAce};
    use windows_sys::Win32::System::SystemServices::{
        ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE,
    };
    let mut storage = read_dacl_descriptor(file).unwrap();
    let mut dacl = ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    // SAFETY: The fixture descriptor owns every inspected ACE and both SIDs remain live.
    unsafe {
        boolean(GetSecurityDescriptorDacl(
            storage.as_mut_ptr().cast(),
            &mut present,
            &mut dacl,
            &mut defaulted,
        ))
        .unwrap();
        assert_ne!(present, 0);
        assert!(!dacl.is_null());
        let mut entries = Vec::new();
        for index in 0..(*dacl).AceCount {
            let mut entry = ptr::null_mut();
            boolean(GetAce(dacl, u32::from(index), &mut entry)).unwrap();
            let header = &*entry.cast::<ACE_HEADER>();
            let kind = if deny {
                ACCESS_DENIED_ACE_TYPE
            } else {
                ACCESS_ALLOWED_ACE_TYPE
            };
            if header.AceType != kind as u8 {
                continue;
            }
            let ace = &*entry.cast::<ACCESS_ALLOWED_ACE>();
            if EqualSid(ptr::from_ref(&ace.SidStart).cast_mut().cast(), sid.as_ptr()) != 0 {
                entries.push((ace.Mask, u32::from(header.AceFlags)));
            }
        }
        entries.sort_unstable();
        entries
    }
}

#[test]
fn managed_ancestors_are_identity_bound_non_inheriting_metadata_grants() {
    let directory = temporary_directory();
    let root = directory.path().join("buddy");
    let parent = root.join("conversations").join("中文 [managed]'task");
    let workspace = parent.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let sibling = parent.join("private.txt");
    fs::write(&sibling, "private").unwrap();
    let mut denied = inspect(root.to_str().unwrap(), Access::DenyRead).unwrap();
    denied.exceptions = vec![workspace.to_str().unwrap().to_owned()];
    let workspace_grant = inspect(workspace.to_str().unwrap(), Access::Read).unwrap();
    let mut grants = vec![denied.clone()];
    assert!(add_traversal_grants(&mut grants).is_err());
    grants.push(workspace_grant);
    add_traversal_grants(&mut grants).unwrap();
    let mut paths: Vec<_> = grants
        .iter()
        .filter(|grant| grant.access == Access::Traverse)
        .map(|grant| {
            assert!(!grant.inherit);
            PathBuf::from(&grant.path)
        })
        .collect();
    paths.sort();
    let mut expected = vec![root.clone(), root.join("conversations"), parent.clone()];
    expected.sort();
    assert_eq!(paths, expected);
    let sid = super::super::account::parse_sid("S-1-5-21-421-432-443-454").unwrap();
    let (_input, cancellation) = pending_cancellation(std::time::Duration::from_secs(30));
    let grant = grants
        .iter()
        .find(|grant| grant.access == Access::Traverse && grant.path == parent.to_str().unwrap())
        .unwrap();
    let file = open_grant(grant).unwrap();
    ensure_acl(
        grant,
        &file,
        &sid,
        DIRECTORY_METADATA,
        GRANT_ACCESS,
        &cancellation,
    )
    .unwrap();
    assert_eq!(
        sid_entries(&file, &sid, false),
        vec![(DIRECTORY_METADATA, 0)]
    );
    let sibling = open_path(sibling.to_str().unwrap()).unwrap();
    assert!(sid_entries(&sibling, &sid, false).is_empty());
    assert_eq!(
        DIRECTORY_METADATA
            & (FILE_GENERIC_WRITE | DELETE | WRITE_DAC)
            & !windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE,
        0
    );
    assert_eq!(
        DIRECTORY_METADATA & windows_sys::Win32::Storage::FileSystem::FILE_READ_DATA,
        0
    );
    drop(sibling);
    drop(file);
    fs::rename(&parent, root.join("moved-task")).unwrap();
    fs::create_dir_all(&parent).unwrap();
    assert_eq!(
        open_grant(grant).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
}

#[test]
fn legacy_denials_upgrade_atomically_keep_file_protection_and_revoke_only_owned_denies() {
    use sha2::{Digest, Sha256};
    use windows_sys::Win32::Security::Authorization::{
        DENY_ACCESS, SE_FILE_OBJECT, SetSecurityInfo,
    };
    use windows_sys::Win32::Security::{INHERIT_ONLY_ACE, INHERITED_ACE};
    let directory = temporary_directory();
    let path = directory.path().to_str().unwrap();
    let root = open_path(path).unwrap();
    let child_path = directory.path().join("private.txt");
    fs::write(&child_path, "private").unwrap();
    let child = open_path(child_path.to_str().unwrap()).unwrap();
    let sid = super::super::account::parse_sid("S-1-5-21-521-532-543-554").unwrap();
    let other = super::super::account::parse_sid("S-1-5-21-521-532-543-555").unwrap();
    let mask = denial_mask(Access::DenyRead).unwrap();
    change_acl(&root, &sid, FILE_GENERIC_READ, GRANT_ACCESS, true).unwrap();
    change_acl(&root, &other, FILE_GENERIC_READ, GRANT_ACCESS, true).unwrap();
    change_acl(&root, &sid, mask, DENY_ACCESS, true).unwrap();
    let mut descriptor = read_dacl_descriptor(&child).unwrap();
    let mut dacl = ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    // SAFETY: The fixture owns this child and the complete live descriptor; make its inheritance explicit.
    unsafe {
        boolean(GetSecurityDescriptorDacl(
            descriptor.as_mut_ptr().cast(),
            &mut present,
            &mut dacl,
            &mut defaulted,
        ))
        .unwrap();
        assert_ne!(present, 0);
        assert!(!dacl.is_null());
        check(SetSecurityInfo(
            child.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION
                | windows_sys::Win32::Security::UNPROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            dacl,
            ptr::null_mut(),
        ))
        .unwrap();
    }
    assert_eq!(sid_entries(&child, &sid, true), vec![(mask, INHERITED_ACE)]);
    let own_allow = sid_entries(&root, &sid, false);
    let other_allow = sid_entries(&root, &other, false);
    let mut grant = inspect(path, Access::DenyRead).unwrap();
    let workspace = directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    grant.exceptions = vec![workspace.to_str().unwrap().to_owned()];
    let key = Sha256::digest(format!(
        "{}:{}:{}:{}:{mask}:{DENY_ACCESS}:true",
        grant.path,
        grant.device,
        grant.inode,
        sid_text(&sid).unwrap(),
    ));
    let pending = journal_directory()
        .unwrap()
        .join(format!("acl-{key:x}.pending"));
    File::create_new(&pending).unwrap().sync_all().unwrap();
    let before = snapshot(&root);
    let (_expired_input, expired) = pending_cancellation(std::time::Duration::ZERO);
    assert_eq!(
        ensure_acl(&grant, &root, &sid, mask, DENY_ACCESS, &expired)
            .unwrap_err()
            .kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(snapshot(&root), before);
    assert!(pending.exists());
    let (_input, cancellation) = pending_cancellation(std::time::Duration::from_secs(30));
    ensure_acl(&grant, &root, &sid, mask, DENY_ACCESS, &cancellation).unwrap();
    assert!(!pending.exists());
    let mut expected = vec![
        (mask & !DIRECTORY_METADATA, 0),
        (
            mask,
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE | INHERIT_ONLY_ACE,
        ),
    ];
    expected.sort_unstable();
    assert_eq!(sid_entries(&root, &sid, true), expected);
    let child_denials = sid_entries(&child, &sid, true);
    assert_eq!(child_denials.len(), 1);
    assert_eq!(child_denials[0].0, mask);
    assert_ne!(child_denials[0].1 & INHERITED_ACE, 0);
    assert_eq!(child_denials[0].1 & INHERIT_ONLY_ACE, 0);
    assert_eq!(sid_entries(&root, &sid, false), own_allow);
    assert_eq!(sid_entries(&root, &other, false), other_allow);
    let before = snapshot(&root);
    ensure_acl(&grant, &root, &sid, mask, DENY_ACCESS, &cancellation).unwrap();
    assert_eq!(snapshot(&root), before);
    File::create_new(&pending).unwrap().sync_all().unwrap();
    ensure_acl(&grant, &root, &sid, mask, DENY_ACCESS, &cancellation).unwrap();
    assert!(!pending.exists());
    assert_eq!(snapshot(&root), before);
    grant.exceptions.clear();
    ensure_acl(&grant, &root, &sid, mask, DENY_ACCESS, &cancellation).unwrap();
    assert_eq!(
        sid_entries(&root, &sid, true),
        vec![(mask, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)]
    );
    revoke_owned(&root, &sid, true, true).unwrap();
    assert!(sid_entries(&root, &sid, true).is_empty());
    assert!(sid_entries(&child, &sid, true).is_empty());
    assert_eq!(sid_entries(&root, &sid, false), own_allow);
    assert_eq!(sid_entries(&root, &other, false), other_allow);
    assert_eq!(fs::read_to_string(child_path).unwrap(), "private");
}

fn pending_cancellation(
    budget: std::time::Duration,
) -> (std::sync::mpsc::Sender<()>, Cancellation) {
    struct Input(std::sync::mpsc::Receiver<()>);
    impl Read for Input {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            let _ = self.0.recv();
            Ok(0)
        }
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    (sender, Cancellation::listen(Input(receiver), budget))
}

#[test]
fn root_preparation_waits_remain_cancellable_and_do_not_lock_other_roots() {
    use std::time::{Duration, Instant};
    let directory = temporary_directory();
    let other = temporary_directory();
    let grant = inspect(directory.path().to_str().unwrap(), Access::Read).unwrap();
    let other_grant = inspect(other.path().to_str().unwrap(), Access::Read).unwrap();
    let (_input, cancellation) = pending_cancellation(Duration::from_secs(10));
    let _lock = AclLock::for_root(&grant, &cancellation).unwrap();
    for interrupted in [false, true] {
        let grant = grant.clone();
        let other_grant = other_grant.clone();
        std::thread::spawn(move || {
            let (input, cancellation) = pending_cancellation(Duration::from_millis(300));
            drop(AclLock::for_root(&other_grant, &cancellation).unwrap());
            if interrupted {
                drop(input);
            }
            let started = Instant::now();
            let error = AclLock::for_root(&grant, &cancellation).err().unwrap();
            assert_eq!(
                error.kind(),
                if interrupted {
                    io::ErrorKind::Interrupted
                } else {
                    io::ErrorKind::TimedOut
                }
            );
            assert!(started.elapsed() < Duration::from_secs(2));
        })
        .join()
        .unwrap();
    }
}

#[test]
fn read_grants_without_write_dacl_skip_root_updates_and_preserve_strict_grants() {
    use std::time::Duration;
    let directory = temporary_directory();
    let path = directory.path().to_str().unwrap();
    let root = open_path(path).unwrap();
    let original = SecurityDescriptor::new(&snapshot(&root)).unwrap();
    let grant = inspect(path, Access::Read).unwrap();
    let restricted = SecurityDescriptor::new("D:P(A;OICI;FRFX;;;OW)").unwrap();
    // SAFETY: This fixture-owned handle retains WRITE_DAC so the original DACL can be restored.
    boolean(unsafe {
        SetKernelObjectSecurity(
            root.as_raw_handle(),
            DACL_SECURITY_INFORMATION,
            restricted.as_ptr(),
        )
    })
    .unwrap();
    let result = std::panic::catch_unwind(|| {
        let before = snapshot(&root);
        let (_input, cancellation) = pending_cancellation(Duration::from_secs(30));
        let _lock = AclLock::for_root(&grant, &cancellation).unwrap();
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let profile = Profile::create().unwrap();
                    let (_input, cancellation) = pending_cancellation(Duration::from_secs(2));
                    Grants::apply(
                        &profile.sid,
                        &profile.sid,
                        std::slice::from_ref(&grant),
                        &cancellation,
                        None,
                    )
                    .unwrap();
                })
                .join()
                .unwrap();
        });
        assert_eq!(snapshot(&root), before);
        for access in [Access::Write, Access::DenyRead, Access::DenyWrite] {
            let strict = Grant {
                access,
                ..grant.clone()
            };
            assert_eq!(
                open_grant(&strict).unwrap_err().kind(),
                io::ErrorKind::PermissionDenied
            );
        }
        let replaced = Grant {
            inode: "0".to_owned(),
            ..grant.clone()
        };
        assert_eq!(
            open_grant(&replaced).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    });
    // SAFETY: The original descriptor and fixture's retained writable handle are still live.
    boolean(unsafe {
        SetKernelObjectSecurity(
            root.as_raw_handle(),
            DACL_SECURITY_INFORMATION,
            original.as_ptr(),
        )
    })
    .unwrap();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[test]
fn interrupted_acl_propagation_retries_then_restores_lock_free_reuse() {
    use sha2::{Digest, Sha256};
    use std::time::Duration;
    let directory = temporary_directory();
    let path = directory.path().to_str().unwrap();
    let root = open_path(path).unwrap();
    let user = sid_text(&process_user_sid(current_process()).unwrap()).unwrap();
    let descriptor = SecurityDescriptor::new(&format!("D:PAI(A;OICI;FA;;;{user})")).unwrap();
    // SAFETY: Only the synthetic root receives a deterministic inheritable DACL before children exist.
    unsafe {
        boolean(SetSecurityDescriptorControl(
            descriptor.as_ptr(),
            SE_DACL_AUTO_INHERIT_REQ,
            SE_DACL_AUTO_INHERIT_REQ,
        ))
        .unwrap();
        boolean(SetKernelObjectSecurity(
            root.as_raw_handle(),
            DACL_SECURITY_INFORMATION,
            descriptor.as_ptr(),
        ))
        .unwrap();
    }
    let child_path = directory.path().join("existing-child");
    fs::create_dir(&child_path).unwrap();
    let child = open_path(child_path.to_str().unwrap()).unwrap();
    let profile = Profile::create().unwrap();
    let grant = inspect(path, Access::Read).unwrap();
    let mask = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    let sid = sid_text(&profile.sid).unwrap();
    let before = snapshot(&child);
    assert!(before.starts_with("D:AI"), "{before}");
    change_acl(&root, &profile.sid, mask, GRANT_ACCESS, true).unwrap();
    assert_eq!(snapshot(&child), before);
    let key = Sha256::digest(format!(
        "{}:{}:{}:{sid}:{mask}:{GRANT_ACCESS}:true",
        grant.path, grant.device, grant.inode,
    ));
    let journal = journal_directory().unwrap();
    let pending = journal.join(format!("acl-{key:x}.pending"));
    File::create_new(&pending).unwrap().sync_all().unwrap();
    let (_input, cancellation) = pending_cancellation(Duration::from_secs(30));
    {
        let _lock = AclLock::acquire().unwrap();
        recover(&journal).unwrap();
    }
    assert!(pending.exists());
    ensure_acl(
        &grant,
        &root,
        &profile.sid,
        mask,
        GRANT_ACCESS,
        &cancellation,
    )
    .unwrap();
    assert!(!pending.exists());
    assert!(
        snapshot(&child).contains(&sid),
        "root: {}; child before: {before}; child after: {}; expected: {sid}",
        snapshot(&root),
        snapshot(&child),
    );
    let _lock = AclLock::for_root(&grant, &cancellation).unwrap();
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let (_input, cancellation) = pending_cancellation(Duration::from_secs(2));
                ensure_acl(
                    &grant,
                    &root,
                    &profile.sid,
                    mask,
                    GRANT_ACCESS,
                    &cancellation,
                )
                .unwrap();
            })
            .join()
            .unwrap();
    });
}
