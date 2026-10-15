use super::RenameSource;
use crate::file_engine::{protocol::Error, resources::identity};
use crate::windows_fs::ParentGuard;
use cap_std::fs::Dir;
use std::{fs, path::Path};

#[test]
fn prepared_rename_pins_source_and_ancestors_and_rejects_late_collision() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("parent");
    fs::create_dir(&parent).unwrap();
    let source = parent.join("source.txt");
    fs::write(&source, "original").unwrap();
    let parents = ParentGuard::new(&source).unwrap();
    let dir = Dir::open_ambient_dir(&parent, cap_std::ambient_authority()).unwrap();
    let expected = identity(&dir.symlink_metadata("source.txt").unwrap()).unwrap();
    let prepared = RenameSource::open(&dir, Path::new("source.txt"), Some(&expected)).unwrap();
    assert!(fs::rename(&source, parent.join("replaced.txt")).is_err());
    assert!(fs::rename(&parent, temp.path().join("replaced-parent")).is_err());
    fs::write(parent.join("target.txt"), "external").unwrap();
    assert!(matches!(
        prepared.rename(&dir, Path::new("target.txt")),
        Err(Error::Conflict)
    ));
    assert_eq!(fs::read_to_string(&source).unwrap(), "original");
    assert_eq!(
        fs::read_to_string(parent.join("target.txt")).unwrap(),
        "external"
    );
    drop(prepared);
    drop(dir);
    drop(parents);
    fs::rename(&parent, temp.path().join("replaced-parent")).unwrap();
}

#[test]
fn replacement_before_open_is_rejected_by_file_identity() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_ambient_dir(temp.path(), cap_std::ambient_authority()).unwrap();
    fs::write(temp.path().join("source"), "original").unwrap();
    let expected = identity(&dir.symlink_metadata("source").unwrap()).unwrap();
    fs::rename(temp.path().join("source"), temp.path().join("original")).unwrap();
    fs::write(temp.path().join("source"), "replacement").unwrap();
    assert!(matches!(
        RenameSource::open(&dir, Path::new("source"), Some(&expected)),
        Err(Error::Conflict)
    ));
    assert_eq!(
        fs::read_to_string(temp.path().join("source")).unwrap(),
        "replacement"
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("original")).unwrap(),
        "original"
    );
}

#[test]
fn unicode_rename_preserves_every_buffer_alignment_and_accepts_path_casing() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_ambient_dir(temp.path(), cap_std::ambient_authority()).unwrap();
    for padding in 0..8 {
        fs::write(temp.path().join("Source.txt"), "original").unwrap();
        let expected = identity(&dir.symlink_metadata("Source.txt").unwrap()).unwrap();
        let prepared = RenameSource::open(&dir, Path::new("sOURCE.TXT"), Some(&expected)).unwrap();
        let name = format!("操作📝{}.txt", "x".repeat(padding));
        prepared.rename(&dir, Path::new(&name)).unwrap();
        assert_eq!(
            fs::read_to_string(temp.path().join(&name)).unwrap(),
            "original"
        );
        assert_eq!(
            identity(&dir.symlink_metadata(&name).unwrap()).unwrap(),
            expected
        );
    }
}

#[test]
fn preparing_creation_and_dropping_guards_does_not_mutate_files() {
    let temp = tempfile::tempdir().unwrap();
    let empty = temp.path().join("empty");
    fs::create_dir(&empty).unwrap();
    let guard = ParentGuard::new(&empty.join("new.txt")).unwrap();
    assert!(fs::rename(&empty, temp.path().join("other")).is_err());
    assert_eq!(fs::read_dir(&empty).unwrap().count(), 0);
    drop(guard);
    fs::rename(&empty, temp.path().join("other")).unwrap();
}

#[test]
fn junction_ancestors_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let outside = temp.path().join("outside");
    let junction = temp.path().join("junction");
    fs::create_dir(&outside).unwrap();
    let output = std::process::Command::new("cmd.exe")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&outside)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(matches!(
        ParentGuard::new(&junction.join("new.txt")),
        Err(error) if error.kind() == std::io::ErrorKind::Unsupported
    ));
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    fs::remove_dir(junction).unwrap();
}
