use lexora_buddy_host::file_writer::{WriteError, WriteRequest, write};
use std::fs;

#[test]
fn atomic_save_preserves_original_on_conflict() {
    let directory = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(directory.path()).unwrap();
    let path = root.join("note.md");
    fs::write(&path, "original\n").unwrap();
    let mut request = WriteRequest {
        root: root.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        expected: "original\n".into(),
        content: "changed\n".into(),
    };
    write(&request).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "changed\n");
    request.content = "overwrite".into();
    assert!(matches!(write(&request), Err(WriteError::Conflict)));
    assert_eq!(fs::read_to_string(&path).unwrap(), "changed\n");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn rejects_symlink_targets_and_ancestors_without_writing_outside() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(directory.path()).unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("note.md"), "original").unwrap();
    symlink(outside.path(), root.join("escape")).unwrap();
    symlink(outside.path().join("note.md"), root.join("note.md")).unwrap();
    for path in [root.join("note.md"), root.join("escape/note.md")] {
        let request = WriteRequest {
            root: root.to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            expected: "original".into(),
            content: "wrong".into(),
        };
        assert!(write(&request).is_err());
    }
    assert_eq!(
        fs::read_to_string(outside.path().join("note.md")).unwrap(),
        "original"
    );
}

#[test]
fn refuses_oversized_content_without_changing_disk() {
    let directory = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(directory.path()).unwrap();
    let path = root.join("note");
    fs::write(&path, "original").unwrap();
    let request = WriteRequest {
        root: root.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        expected: "original".into(),
        content: "x".repeat(1024 * 1024 + 1),
    };
    assert!(write(&request).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "original");
}

#[cfg(target_os = "linux")]
#[test]
fn preserves_permissions_and_attributes_and_refuses_hardlinks() {
    use rustix::fs::{XattrFlags, getxattr, setxattr};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let directory = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(directory.path()).unwrap();
    let path = root.join("note.md");
    fs::write(&path, "original").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    setxattr(
        &path,
        "user.lexora-fixture",
        b"retained",
        XattrFlags::empty(),
    )
    .unwrap();
    let before = fs::metadata(&path).unwrap();
    let request = WriteRequest {
        root: root.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        expected: "original".into(),
        content: "changed".into(),
    };
    write(&request).unwrap();
    let after = fs::metadata(&path).unwrap();
    assert_eq!(after.mode(), before.mode());
    assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
    let mut value = [0; 32];
    let count = getxattr(&path, "user.lexora-fixture", value.as_mut_slice()).unwrap();
    assert_eq!(&value[..count], b"retained");
    fs::hard_link(&path, root.join("linked")).unwrap();
    let request = WriteRequest {
        expected: "changed".into(),
        content: "wrong".into(),
        ..request
    };
    assert!(write(&request).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "changed");
    assert_eq!(fs::read_to_string(root.join("linked")).unwrap(), "changed");
}
