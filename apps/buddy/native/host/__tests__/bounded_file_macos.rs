#![cfg(target_os = "macos")]

use lexora_buddy_host::file_reader::{ReadError, ReadRequest, read_bounded_file};
use std::{fs, os::unix::fs::symlink, path::Path};

fn read(root: &Path, path: &Path, max_bytes: u64) -> Result<Vec<u8>, ReadError> {
    read_bounded_file(&ReadRequest {
        root: root.to_str().unwrap().to_owned(),
        path: path.to_str().unwrap().to_owned(),
        max_bytes,
    })
}

#[test]
fn reads_canonical_regular_files_and_enforces_byte_limits() {
    let directory = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(directory.path()).unwrap();
    let file = root.join("文档.txt");
    fs::write(&file, b"hello").unwrap();
    assert_eq!(read(&root, &file, 5).unwrap(), b"hello");
    assert!(matches!(read(&root, &file, 4), Err(ReadError::OutputLimit)));
    fs::write(&file, []).unwrap();
    assert!(read(&root, &file, 0).unwrap().is_empty());
}

#[test]
fn rejects_symlinks_ancestors_and_special_files() {
    let directory = tempfile::tempdir().unwrap();
    let parent = fs::canonicalize(directory.path()).unwrap();
    let root = parent.join("root");
    fs::create_dir(&root).unwrap();
    fs::write(parent.join("secret"), b"outside").unwrap();
    symlink(&parent, root.join("escape")).unwrap();
    assert!(read(&root, &root.join("escape/secret"), 32).is_err());
    assert!(read(&root, &root.join("../secret"), 32).is_err());
    symlink(&root, parent.join("alias")).unwrap();
    assert!(read(&parent.join("alias"), &parent.join("alias/secret"), 32).is_err());
    let fifo = root.join("fifo");
    assert!(
        std::process::Command::new("/usr/bin/mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    assert!(read(&root, &fifo, 32).is_err());
    assert!(read(&root, &root, 32).is_err());
    assert!(read(Path::new("/dev"), Path::new("/dev/null"), 32).is_err());
}

#[test]
fn replacing_a_file_with_an_escape_never_discloses_outside_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let parent = fs::canonicalize(directory.path()).unwrap();
    let root = parent.join("root");
    fs::create_dir(&root).unwrap();
    let outside = parent.join("secret");
    fs::write(&outside, b"outside").unwrap();
    let file = root.join("file");
    fs::write(&file, b"allowed").unwrap();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            for iteration in 0..500 {
                let candidate = root.join("candidate");
                if iteration % 2 == 0 {
                    fs::write(&candidate, b"allowed").unwrap();
                } else {
                    symlink(&outside, &candidate).unwrap();
                }
                fs::rename(&candidate, &file).unwrap();
            }
        });
        for _ in 0..500 {
            if let Ok(bytes) = read(&root, &file, 32) {
                assert_eq!(bytes, b"allowed");
            }
        }
    });
}
