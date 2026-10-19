use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::GetKernelObjectSecurity;

use super::*;

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
    let directory = tempfile::tempdir().unwrap();
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
    let directory = tempfile::tempdir().unwrap();
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
    let directory = tempfile::tempdir().unwrap();
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
    let directory = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
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
    let directory = tempfile::tempdir().unwrap();
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
        assert!(!open_grant_handle(&grant).unwrap().can_write_dacl);
        let before = snapshot(&root);
        let (_input, cancellation) = pending_cancellation(Duration::from_secs(30));
        let _lock = AclLock::for_root(&grant, &cancellation).unwrap();
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let profile = Profile::create().unwrap();
                    let (_input, cancellation) = pending_cancellation(Duration::from_secs(2));
                    let grants = Grants::apply(
                        &profile.sid,
                        &profile.sid,
                        std::slice::from_ref(&grant),
                        &cancellation,
                        None,
                    )
                    .unwrap();
                    assert!(grants.capabilities.is_empty());
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
    let directory = tempfile::tempdir().unwrap();
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
