use super::*;
use std::{sync::mpsc, time::Duration};
use windows_sys::Win32::Security::Authorization::GRANT_ACCESS;
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, EqualSid, GetAce, GetSecurityDescriptorDacl,
};
use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_READ;
use windows_sys::Win32::System::SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE};

fn temporary_directory() -> tempfile::TempDir {
    let canonical = fs::canonicalize(std::env::temp_dir()).unwrap();
    let path = canonical.to_str().unwrap().strip_prefix(r"\\?\").unwrap();
    tempfile::tempdir_in(path).unwrap()
}

fn cancellation() -> (mpsc::Sender<()>, Cancellation) {
    struct Input(mpsc::Receiver<()>);
    impl Read for Input {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            let _ = self.0.recv();
            Ok(0)
        }
    }
    let (send, receive) = mpsc::channel();
    (
        send,
        Cancellation::listen(Input(receive), Duration::from_secs(30)),
    )
}

fn entries(path: &Path, sid: &Sid, deny: bool) -> usize {
    let grant = filesystem::inspect(path.to_str().unwrap(), Access::Read).unwrap();
    let file = filesystem::open_grant(&grant).unwrap();
    let mut descriptor = filesystem::read_dacl_descriptor(&file).unwrap();
    let mut dacl = ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    // SAFETY: The complete descriptor owns the ACL queried by the test.
    boolean(unsafe {
        GetSecurityDescriptorDacl(
            descriptor.as_mut_ptr().cast(),
            &mut present,
            &mut dacl,
            &mut defaulted,
        )
    })
    .unwrap();
    let mut count = 0;
    // SAFETY: A successful DACL query returned this live ACL.
    for index in 0..unsafe { (*dacl).AceCount } {
        let mut entry = ptr::null_mut();
        // SAFETY: This bounded index addresses a live ACE.
        boolean(unsafe { GetAce(dacl, u32::from(index), &mut entry) }).unwrap();
        // SAFETY: Every ACE begins with this header.
        let header = unsafe { &*entry.cast::<ACE_HEADER>() };
        let kind = if deny {
            ACCESS_DENIED_ACE_TYPE
        } else {
            ACCESS_ALLOWED_ACE_TYPE
        };
        if header.AceType != kind as u8 {
            continue;
        }
        // SAFETY: Only the simple allow/deny ACE layouts reach this SID comparison.
        let ace = unsafe { &*entry.cast::<ACCESS_ALLOWED_ACE>() };
        // SAFETY: Both SIDs have live backing allocations.
        if unsafe { EqualSid(ptr::from_ref(&ace.SidStart).cast_mut().cast(), sid.as_ptr()) } != 0 {
            count += 1;
        }
    }
    count
}

#[test]
fn obsolete_denials_preserve_allows_and_other_profiles_until_the_last_owner_releases() {
    let temporary = temporary_directory();
    let protected = temporary.path().join("protected");
    fs::create_dir(&protected).unwrap();
    let child = protected.join("existing.txt");
    fs::write(&child, "fixture").unwrap();
    let grant = filesystem::inspect(protected.to_str().unwrap(), Access::DenyRead).unwrap();
    let sid = super::super::account::parse_sid("S-1-5-21-161-172-183-194").unwrap();
    let other = super::super::account::parse_sid("S-1-5-21-161-172-183-195").unwrap();
    let (_send, cancellation) = cancellation();
    let file = filesystem::open_grant(&grant).unwrap();
    filesystem::ensure_acl(
        &grant,
        &file,
        &sid,
        FILE_GENERIC_READ,
        GRANT_ACCESS,
        &cancellation,
    )
    .unwrap();
    filesystem::ensure_acl(
        &grant,
        &file,
        &other,
        FILE_GENERIC_READ,
        DENY_ACCESS,
        &cancellation,
    )
    .unwrap();
    let state = temporary.path().join("state.json");
    reconcile(
        &state,
        DenialUpdate::Replace("profile-a"),
        &sid,
        std::slice::from_ref(&grant),
        &cancellation,
    )
    .unwrap();
    reconcile(
        &state,
        DenialUpdate::Replace("profile-b"),
        &sid,
        std::slice::from_ref(&grant),
        &cancellation,
    )
    .unwrap();
    reconcile(
        &state,
        DenialUpdate::Replace("profile-a"),
        &sid,
        &[],
        &cancellation,
    )
    .unwrap();
    assert_eq!(entries(&protected, &sid, true), 1);
    reconcile(
        &state,
        DenialUpdate::Replace("profile-b"),
        &sid,
        &[],
        &cancellation,
    )
    .unwrap();
    for path in [&protected, &child] {
        assert_eq!(entries(path, &sid, true), 0);
        assert_eq!(entries(path, &sid, false), 1);
        assert_eq!(entries(path, &other, true), 1);
    }
    assert!(read::<Denials>(&state, false).unwrap().is_empty());
}

#[test]
fn merged_denials_preserve_previous_roots_and_are_reconciled_by_their_owner() {
    let temporary = temporary_directory();
    let old = temporary.path().join("old");
    let late = temporary.path().join("late");
    fs::create_dir(&old).unwrap();
    let old_grant = filesystem::inspect(old.to_str().unwrap(), Access::DenyRead).unwrap();
    let sid = super::super::account::parse_sid("S-1-5-21-561-572-583-594").unwrap();
    let state = temporary.path().join("state.json");
    let (_send, cancellation) = cancellation();
    reconcile(
        &state,
        DenialUpdate::Replace("profile"),
        &sid,
        &[old_grant],
        &cancellation,
    )
    .unwrap();
    fs::create_dir(&late).unwrap();
    let child = late.join("existing.txt");
    fs::write(&child, "fixture").unwrap();
    let late_grant = filesystem::inspect(late.to_str().unwrap(), Access::DenyRead).unwrap();
    for scope in ["profile", "other-profile"] {
        reconcile(
            &state,
            DenialUpdate::Merge(scope),
            &sid,
            std::slice::from_ref(&late_grant),
            &cancellation,
        )
        .unwrap();
    }
    let before = filesystem::inspect(state.to_str().unwrap(), Access::Read).unwrap();
    reconcile(
        &state,
        DenialUpdate::Merge("PROFILE"),
        &sid,
        std::slice::from_ref(&late_grant),
        &cancellation,
    )
    .unwrap();
    let after = filesystem::inspect(state.to_str().unwrap(), Access::Read).unwrap();
    assert_eq!((before.device, before.inode), (after.device, after.inode));
    assert_eq!(
        read::<Denials>(&state, false).unwrap()["PROFILE"]
            .roots
            .len(),
        2
    );
    assert_eq!(entries(&old, &sid, true), 1);
    reconcile(
        &state,
        DenialUpdate::Replace("profile"),
        &sid,
        &[],
        &cancellation,
    )
    .unwrap();
    assert_eq!(entries(&old, &sid, true), 0);
    assert_eq!(entries(&child, &sid, true), 1);
    reconcile(
        &state,
        DenialUpdate::Replace("other-profile"),
        &sid,
        &[],
        &cancellation,
    )
    .unwrap();
    assert_eq!(entries(&child, &sid, true), 0);
    assert_eq!(fs::read_to_string(child).unwrap(), "fixture");
    assert!(read::<Denials>(&state, false).unwrap().is_empty());
}

#[test]
fn failed_updates_keep_recovery_intent_and_previous_protection() {
    let temporary = temporary_directory();
    let old = temporary.path().join("old");
    let new = temporary.path().join("new");
    fs::create_dir(&old).unwrap();
    fs::create_dir(&new).unwrap();
    let old_grant = filesystem::inspect(old.to_str().unwrap(), Access::DenyRead).unwrap();
    let new_grant = filesystem::inspect(new.to_str().unwrap(), Access::DenyRead).unwrap();
    let sid = super::super::account::parse_sid("S-1-5-21-261-272-283-294").unwrap();
    let state = temporary.path().join("state.json");
    let (_send, cancellation) = cancellation();
    reconcile(
        &state,
        DenialUpdate::Replace("profile"),
        &sid,
        &[old_grant],
        &cancellation,
    )
    .unwrap();
    fs::remove_dir(&new).unwrap();
    assert!(
        reconcile(
            &state,
            DenialUpdate::Replace("profile"),
            &sid,
            &[new_grant],
            &cancellation
        )
        .is_err()
    );
    assert_eq!(entries(&old, &sid, true), 1);
    assert_eq!(
        read::<Denials>(&state, false).unwrap()["PROFILE"]
            .roots
            .len(),
        2
    );
    fs::create_dir(&new).unwrap();
    let replacement = filesystem::inspect(new.to_str().unwrap(), Access::DenyRead).unwrap();
    reconcile(
        &state,
        DenialUpdate::Replace("profile"),
        &sid,
        &[replacement],
        &cancellation,
    )
    .unwrap();
    assert_eq!(entries(&old, &sid, true), 0);
    assert_eq!(entries(&new, &sid, true), 1);
    assert_eq!(
        read::<Denials>(&state, false).unwrap()["PROFILE"]
            .roots
            .len(),
        1
    );
}

#[test]
fn reconciliation_never_changes_a_replacement_object() {
    let temporary = temporary_directory();
    let path = temporary.path().join("protected");
    fs::create_dir(&path).unwrap();
    let grant = filesystem::inspect(path.to_str().unwrap(), Access::DenyRead).unwrap();
    let sid = super::super::account::parse_sid("S-1-5-21-361-372-383-394").unwrap();
    let (_send, cancellation) = cancellation();
    let state = temporary.path().join("state.json");
    reconcile(
        &state,
        DenialUpdate::Replace("profile"),
        &sid,
        &[grant],
        &cancellation,
    )
    .unwrap();
    fs::rename(&path, temporary.path().join("moved")).unwrap();
    fs::create_dir(&path).unwrap();
    let replacement = filesystem::inspect(path.to_str().unwrap(), Access::DenyRead).unwrap();
    let file = filesystem::open_grant(&replacement).unwrap();
    filesystem::ensure_acl(
        &replacement,
        &file,
        &sid,
        FILE_GENERIC_READ,
        DENY_ACCESS,
        &cancellation,
    )
    .unwrap();
    reconcile(
        &state,
        DenialUpdate::Replace("profile"),
        &sid,
        &[],
        &cancellation,
    )
    .unwrap();
    assert_eq!(entries(&path, &sid, true), 1);
}

#[test]
fn owned_acl_cleanup_propagates_without_removing_other_principals() {
    let temporary = temporary_directory();
    let child = temporary.path().join("existing.txt");
    fs::write(&child, "fixture").unwrap();
    let root = filesystem::inspect(temporary.path().to_str().unwrap(), Access::Write).unwrap();
    let file = filesystem::open_grant(&root).unwrap();
    let sid = super::super::account::parse_sid("S-1-5-21-461-472-483-494").unwrap();
    let other = super::super::account::parse_sid("S-1-5-21-461-472-483-495").unwrap();
    let (_send, cancellation) = cancellation();
    filesystem::ensure_acl(
        &root,
        &file,
        &sid,
        FILE_GENERIC_READ,
        GRANT_ACCESS,
        &cancellation,
    )
    .unwrap();
    filesystem::ensure_acl(
        &root,
        &file,
        &other,
        FILE_GENERIC_READ,
        GRANT_ACCESS,
        &cancellation,
    )
    .unwrap();
    filesystem::revoke_owned(&file, &sid, false, true).unwrap();
    filesystem::revoke_owned(&file, &sid, false, true).unwrap();
    for path in [temporary.path(), &child] {
        assert_eq!(entries(path, &sid, false), 0);
        assert_eq!(entries(path, &other, false), 1);
    }
    assert_eq!(fs::read_to_string(child).unwrap(), "fixture");
}
