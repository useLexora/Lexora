use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

use super::*;

struct Fixture(std::path::PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "buddy-private-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn creates_nested_unicode_directories_and_reuses_them_without_replacing_files() {
    let fixture = Fixture::new();
    let path = fixture.0.join("示例").join("private");
    let paths = [path.to_str().unwrap().to_owned()];
    super::super::ensure(&paths).unwrap();
    fs::write(path.join("preserved.txt"), "fixture").unwrap();
    super::super::ensure(&paths).unwrap();
    assert_eq!(
        fs::read_to_string(path.join("preserved.txt")).unwrap(),
        "fixture"
    );
}

#[test]
fn ordinary_files_cannot_be_used_as_private_directories() {
    let fixture = Fixture::new();
    let path = fixture.0.join("file");
    fs::write(&path, "fixture").unwrap();
    let failure = super::super::ensure(&[path.to_str().unwrap().to_owned()]).unwrap_err();
    assert_eq!(failure.operation, DirectoryOperation::OpenDirectory);
    assert_eq!(failure.directory_index, Some(0));
    assert!(failure.system_error.is_some());
    assert_eq!(fs::read_to_string(path).unwrap(), "fixture");
}

#[test]
fn open_parent_handle_prevents_renaming_the_directory_chain() {
    let fixture = Fixture::new();
    let parent_path = fixture.0.join("parent");
    let root = open_root(fixture.0.to_str().unwrap()).unwrap();
    let security = PrivateSecurity::new().unwrap();
    let (parent, _) = open_child(&root, "parent", &security, false).unwrap();
    assert!(fs::rename(&parent_path, fixture.0.join("moved")).is_err());
    let (child, created) = open_child(&parent, "child", &security, true).unwrap();
    assert!(created);
    security.validate(&child).unwrap();
    assert!(fs::rename(parent_path.join("child"), parent_path.join("moved-child")).is_err());
}
