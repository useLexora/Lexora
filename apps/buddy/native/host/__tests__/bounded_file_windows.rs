#![cfg(windows)]

use lexora_buddy_host::{
    file_reader::{ReadRequest, read_bounded_file},
    file_writer::{WriteRequest, write},
};
use std::{
    fs,
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

fn public(path: &Path) -> PathBuf {
    let canonical = fs::canonicalize(path).unwrap();
    let value = canonical.to_str().unwrap();
    PathBuf::from(value.strip_prefix(r"\\?\").unwrap())
}

fn read(root: &Path, path: &Path) -> Result<Vec<u8>, lexora_buddy_host::file_reader::ReadError> {
    read_bounded_file(&ReadRequest {
        root: root.to_str().unwrap().into(),
        path: path.to_str().unwrap().into(),
        max_bytes: 1024,
    })
}

fn save(root: &Path, path: &Path) -> Result<(), lexora_buddy_host::file_writer::WriteError> {
    write(&WriteRequest {
        root: root.to_str().unwrap().into(),
        path: path.to_str().unwrap().into(),
        expected: "original".into(),
        content: "changed".into(),
    })
}

#[test]
fn accepts_casing_aliases_and_drive_root_without_escaping_the_grant() {
    let temp = tempfile::tempdir().unwrap();
    let root = public(temp.path());
    let mixed = root.join("MixedCase");
    fs::create_dir(&mixed).unwrap();
    let file = mixed.join("Note.TXT");
    fs::write(&file, "original").unwrap();
    let alias_root = PathBuf::from(mixed.to_str().unwrap().to_ascii_lowercase());
    let alias_file = PathBuf::from(file.to_str().unwrap().to_ascii_lowercase());
    assert_eq!(read(&alias_root, &alias_file).unwrap(), b"original");
    save(&alias_root, &alias_file).unwrap();
    assert_eq!(read(&mixed, &file).unwrap(), b"changed");
    let drive = Path::new(&root.to_str().unwrap()[..3]);
    assert_eq!(read(drive, &file).unwrap(), b"changed");
    fs::write(root.join("outside.txt"), "original").unwrap();
    assert!(read(&mixed, &root.join("outside.txt")).is_err());
    assert!(save(&mixed, &root.join("outside.txt")).is_err());
    assert_eq!(
        fs::read_to_string(root.join("outside.txt")).unwrap(),
        "original"
    );
}

#[test]
fn long_unicode_paths_can_be_read_and_saved_without_changing_system_settings() {
    let temp = tempfile::tempdir().unwrap();
    let root = public(temp.path());
    let mut parent = root.clone();
    for _ in 0..7 {
        parent.push("文件夹-long-directory-📝-0123456789");
    }
    fs::create_dir_all(&parent).unwrap();
    let file = parent.join("笔记📝.txt");
    assert!(file.to_str().unwrap().encode_utf16().count() > 260);
    fs::write(&file, "original").unwrap();
    assert_eq!(read(&root, &file).unwrap(), b"original");
    save(&root, &file).unwrap();
    assert_eq!(read(&root, &file).unwrap(), b"changed");
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
}

#[test]
fn readonly_and_locked_files_keep_the_original_and_leave_no_save_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let root = public(temp.path());
    let path = root.join("note.txt");
    fs::write(&path, "original").unwrap();
    let original_permissions = fs::metadata(&path).unwrap().permissions();
    let mut readonly = original_permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    assert!(save(&root, &path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    assert!(fs::metadata(&path).unwrap().permissions().readonly());
    fs::set_permissions(&path, original_permissions).unwrap();
    let occupied = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&path)
        .unwrap();
    assert!(save(&root, &path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    drop(occupied);
    save(&root, &path).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "changed");
}

#[test]
fn hardlinked_files_are_not_silently_split_by_save() {
    let temp = tempfile::tempdir().unwrap();
    let root = public(temp.path());
    let path = root.join("note.txt");
    fs::write(&path, "original").unwrap();
    fs::hard_link(&path, root.join("alias.txt")).unwrap();
    assert!(save(&root, &path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    assert_eq!(
        fs::read_to_string(root.join("alias.txt")).unwrap(),
        "original"
    );
    assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
}

#[test]
fn junctions_cannot_redirect_reads_or_saves_outside_the_grant() {
    let temp = tempfile::tempdir().unwrap();
    let root = public(temp.path());
    let grant = root.join("grant");
    let outside = root.join("outside");
    fs::create_dir(&grant).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("note.txt"), "original").unwrap();
    let junction = grant.join("junction");
    let output = std::process::Command::new("cmd.exe")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&outside)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(read(&grant, &junction.join("note.txt")).is_err());
    assert!(save(&grant, &junction.join("note.txt")).is_err());
    assert_eq!(
        fs::read_to_string(outside.join("note.txt")).unwrap(),
        "original"
    );
    fs::remove_dir(junction).unwrap();
}

#[test]
#[ignore = "requires access to the local administrative SMB share"]
fn unc_paths_keep_read_and_save_within_the_shared_directory() {
    let temp = tempfile::tempdir().unwrap();
    let local = public(temp.path());
    let value = local.to_str().unwrap();
    let root = PathBuf::from(format!(r"\\localhost\{}$\{}", &value[..1], &value[3..]));
    let file = root.join("UNC-操作📝.txt");
    fs::write(&file, "original").unwrap();
    assert_eq!(read(&root, &file).unwrap(), b"original");
    save(&root, &file).unwrap();
    assert_eq!(read(&root, &file).unwrap(), b"changed");
}

#[test]
#[ignore = "requires permission to enable NTFS case-sensitive directories"]
fn case_sensitive_sibling_directory_is_not_inside_the_grant() {
    let temp = tempfile::tempdir().unwrap();
    let parent = public(temp.path());
    let output = std::process::Command::new("fsutil.exe")
        .args(["file", "setCaseSensitiveInfo"])
        .arg(&parent)
        .arg("enable")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let root = parent.join("Case");
    let outside = parent.join("case");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(root.join("note"), "inside").unwrap();
    fs::write(outside.join("note"), "original").unwrap();
    assert_eq!(read(&root, &root.join("note")).unwrap(), b"inside");
    assert!(read(&root, &outside.join("note")).is_err());
    assert!(save(&root, &outside.join("note")).is_err());
    assert_eq!(
        fs::read_to_string(outside.join("note")).unwrap(),
        "original"
    );
}
