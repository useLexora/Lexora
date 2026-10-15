use std::{fs, io::Cursor, os::unix::fs::symlink};

use super::*;

fn package(directory: &Path) -> Installation {
    let path = directory.join("Lexora-Buddy-1.2.3-arch-x86_64.pkg.tar.zst");
    fs::write(&path, b"verified package").unwrap();
    Installation {
        format: Format::Pacman,
        package: path,
        sha256: format!("{:x}", Sha256::digest(b"verified package")),
        size: 16,
        parent: std::process::id(),
    }
}

#[test]
fn staged_package_is_an_independent_verified_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let installation = package(directory.path());
    let staged = stage_package(&installation, geteuid().as_raw()).unwrap();
    fs::write(&installation.package, b"changed contents").unwrap();
    assert_eq!(fs::read(&staged.file).unwrap(), b"verified package");
    let stage_directory = staged.directory.clone();
    drop(staged);
    assert!(!stage_directory.exists());
}

#[test]
fn rejects_tampering_symlinks_and_wrong_owner() {
    let directory = tempfile::tempdir().unwrap();
    let mut installation = package(directory.path());
    installation.sha256 = "0".repeat(64);
    assert!(stage_package(&installation, geteuid().as_raw()).is_err());
    installation = package(directory.path());
    assert!(stage_package(&installation, geteuid().as_raw() + 1).is_err());
    let link = directory.path().join("Lexora-Buddy-symlink.pkg.tar.zst");
    symlink(&installation.package, &link).unwrap();
    installation.package = link;
    assert!(stage_package(&installation, geteuid().as_raw()).is_err());
}

#[test]
fn install_protocol_requires_complete_bounded_messages() {
    assert_eq!(read_line(&mut Cursor::new("commit\n")).unwrap(), "commit\n");
    assert!(read_line(&mut Cursor::new("commit")).is_err());
    assert!(read_line(&mut Cursor::new(format!("{}\n", "x".repeat(65537)))).is_err());
    assert!(
        serde_json::from_str::<Installation>(
            r#"{"format":"shell","package":"/tmp/p","sha256":"a","size":1,"parent":1}"#
        )
        .is_err()
    );
}
