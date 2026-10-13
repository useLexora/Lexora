use super::super::security::{Profile, current_process};
use super::*;

fn record(path: &Path, profile: &str) -> Record {
    let canonical = fs::canonicalize(path).unwrap();
    let text = canonical.to_str().unwrap().strip_prefix(r"\\?\").unwrap();
    let file = open(text).unwrap();
    let (device, inode) = filesystem::identity(&file, text).unwrap();
    Record {
        profile: profile.to_owned(),
        user: sid_text(&process_user_sid(current_process()).unwrap()).unwrap(),
        null_device: false,
        directories: vec![Directory {
            path: text.to_owned(),
            device,
            inode,
        }],
    }
}

#[test]
fn cleanup_is_per_command_and_does_not_propagate_to_children() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path().to_str().unwrap()).unwrap();
    let original = filesystem::read_dacl_descriptor(&root).unwrap();
    let first = Profile::create().unwrap();
    let second = Profile::create().unwrap();
    let first_sid = capability(&first.name).unwrap();
    let second_sid = capability(&second.name).unwrap();
    filesystem::change_acl(&root, &first_sid, FILE_READ_ATTRIBUTES, GRANT_ACCESS, false).unwrap();
    filesystem::change_acl(
        &root,
        &second_sid,
        FILE_READ_ATTRIBUTES,
        GRANT_ACCESS,
        false,
    )
    .unwrap();
    let child_path = directory.path().join("child");
    fs::create_dir(&child_path).unwrap();
    let child = open(child_path.to_str().unwrap()).unwrap();
    assert!(!has_capability(&child, &first_sid).unwrap());
    revoke(&root, &first_sid).unwrap();
    assert!(!has_capability(&root, &first_sid).unwrap());
    assert!(has_capability(&root, &second_sid).unwrap());
    revoke(&root, &second_sid).unwrap();
    assert_eq!(filesystem::read_dacl_descriptor(&root).unwrap(), original);
}

#[test]
fn recovery_preserves_unrelated_grants_and_removes_only_its_published_lease() {
    let directory = tempfile::tempdir().unwrap();
    let journals = tempfile::tempdir().unwrap();
    let profile = Profile::create().unwrap();
    let sid = capability(&profile.name).unwrap();
    let root = open(directory.path().to_str().unwrap()).unwrap();
    let unrelated = Profile::create().unwrap();
    filesystem::change_acl(
        &root,
        &unrelated.sid,
        FILE_READ_ATTRIBUTES,
        GRANT_ACCESS,
        false,
    )
    .unwrap();
    let before = filesystem::read_dacl_descriptor(&root).unwrap();
    let journal = publish(journals.path(), &record(directory.path(), &profile.name)).unwrap();
    filesystem::change_acl(&root, &sid, FILE_READ_ATTRIBUTES, GRANT_ACCESS, false).unwrap();
    recover_record(&journal, &profile.name).unwrap();
    assert!(!journal.exists());
    assert_eq!(filesystem::read_dacl_descriptor(&root).unwrap(), before);
}

#[test]
fn recovery_retains_evidence_when_a_directory_identity_has_changed() {
    let directory = tempfile::tempdir().unwrap();
    let journals = tempfile::tempdir().unwrap();
    let profile = Profile::create().unwrap();
    let original = directory.path().join("original");
    fs::create_dir(&original).unwrap();
    let journal = publish(journals.path(), &record(&original, &profile.name)).unwrap();
    fs::rename(&original, directory.path().join("moved")).unwrap();
    fs::create_dir(&original).unwrap();
    let replacement = open(original.to_str().unwrap()).unwrap();
    let before = filesystem::read_dacl_descriptor(&replacement).unwrap();
    assert!(recover_record(&journal, &profile.name).is_err());
    assert!(journal.exists());
    assert_eq!(
        filesystem::read_dacl_descriptor(&replacement).unwrap(),
        before
    );
}

#[test]
fn cleanup_refuses_capability_entries_with_unexpected_permissions() {
    let directory = tempfile::tempdir().unwrap();
    let profile = Profile::create().unwrap();
    let sid = capability(&profile.name).unwrap();
    let root = open(directory.path().to_str().unwrap()).unwrap();
    filesystem::change_acl(
        &root,
        &sid,
        FILE_READ_ATTRIBUTES | WRITE_DAC,
        GRANT_ACCESS,
        false,
    )
    .unwrap();
    let before = filesystem::read_dacl_descriptor(&root).unwrap();
    assert!(revoke(&root, &sid).is_err());
    assert_eq!(filesystem::read_dacl_descriptor(&root).unwrap(), before);
}
