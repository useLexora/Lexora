use super::{Engine, id};
use serde_json::json;
use std::fs;

#[test]
fn shared_read_handle_does_not_leave_a_recovery_hazard_after_release() {
    rejected_existing_write_can_continue(false);
}

#[test]
fn readonly_attribute_does_not_leave_a_recovery_hazard_after_restoration() {
    rejected_existing_write_can_continue(true);
}

fn rejected_existing_write_can_continue(readonly: bool) {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    fs::create_dir(&root).unwrap();
    let path = root.join("note.txt");
    fs::write(&path, "original").unwrap();
    let permissions = fs::metadata(&path).unwrap().permissions();
    let occupied = if readonly {
        let mut restricted = permissions.clone();
        restricted.set_readonly(true);
        fs::set_permissions(&path, restricted).unwrap();
        None
    } else {
        Some(
            fs::OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ)
                .open(&path)
                .unwrap(),
        )
    };
    let journal = temp.path().join("journal");
    let mut engine = Engine::new(&journal);
    engine.register("space", &root);
    let operation = id();
    let action = json!({"kind":"write","text":"must-not-be-replayed"});
    let rejected = engine.mutate(&operation, "space", "note.txt", action.clone());
    drop(occupied);
    fs::set_permissions(&path, permissions).unwrap();
    assert_eq!(rejected["result"]["status"], "not-applied", "{rejected}");
    assert_eq!(rejected["result"]["error"], "FILE_IO_FAILED", "{rejected}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    let duplicate = engine.mutate(&operation, "space", "note.txt", action);
    assert_eq!(duplicate["result"], rejected["result"]);
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    let continued = engine.mutate(
        &id(),
        "space",
        "note.txt",
        json!({"kind":"write","text":"after-release"}),
    );
    assert_eq!(continued["result"]["status"], "applied", "{continued}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "after-release");
    drop(engine);
    let mut engine = Engine::new(&journal);
    engine.register("space", &root);
    let history = engine.call(json!({"type":"history","root":"space"}));
    assert!(
        history["result"]
            .as_array()
            .unwrap()
            .iter()
            .all(|record| record["status"] != "needs-recovery")
    );
    let continued = engine.mutate(
        &id(),
        "space",
        "note.txt",
        json!({"kind":"write","text":"after-restart"}),
    );
    assert_eq!(continued["result"]["status"], "applied", "{continued}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "after-restart");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn rejects_invalid_names_before_creating_an_operation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    fs::create_dir(&root).unwrap();
    let mut engine = Engine::new(&temp.path().join("journal"));
    engine.register("space", &root);
    for name in [
        "CON",
        "COM¹.txt",
        "LPT²",
        "NUL .txt",
        "bad\u{1}",
        "trailing.",
        "..",
        "",
        "folder/../escape",
        "file:stream",
        &"📝".repeat(128),
    ] {
        let result = engine.mutate(&id(), "space", name, json!({"kind":"createFile"}));
        assert!(result.get("error").is_some(), "{name:?}: {result}");
    }
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
}

#[test]
fn unicode_directory_trash_restores_from_shell_receipt_after_restart() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("CaseRoot");
    fs::create_dir_all(root.join("Folder 操作📝/nested")).unwrap();
    fs::write(root.join("Folder 操作📝/nested/内容.txt"), "retained").unwrap();
    let journal = temp.path().join("journal");
    let mut engine = Engine::new(&journal);
    engine.register("space", &root);
    let operation = id();
    let result = engine.mutate(
        &operation,
        "space",
        "folder 操作📝",
        json!({"kind":"trash"}),
    );
    assert_eq!(result["result"]["status"], "applied", "{result}");
    assert_eq!(
        result["result"]["receipt"]["trashIdentity"],
        result["result"]["receipt"]["sourceIdentity"]
    );
    assert!(!root.join("Folder 操作📝").exists());
    drop(engine);
    let mut engine = Engine::new(&journal);
    engine.register("space", &root);
    let restored = engine.mutate(
        &id(),
        "space",
        "folder 操作📝",
        json!({"kind":"restore","originalOperationId":operation}),
    );
    assert_eq!(restored["result"]["status"], "applied", "{restored}");
    assert_eq!(
        fs::read_to_string(root.join("folder 操作📝/nested/内容.txt")).unwrap(),
        "retained"
    );
}

#[test]
fn unicode_case_only_rename_preserves_the_file() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("ÉTÉ.txt"), "contents").unwrap();
    let mut engine = Engine::new(&temp.path().join("journal"));
    engine.register("space", &root);
    let result = engine.mutate(
        &id(),
        "space",
        "ÉTÉ.txt",
        json!({"kind":"rename","destination":"été.txt"}),
    );
    assert_eq!(result["result"]["status"], "applied", "{result}");
    assert_eq!(
        fs::read_dir(&root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .file_name(),
        "été.txt"
    );
    assert_eq!(
        fs::read_to_string(root.join("été.txt")).unwrap(),
        "contents"
    );
}

#[test]
#[ignore = "requires access to the local administrative SMB share"]
fn network_delete_is_rejected_without_permanently_deleting_the_file() {
    let temp = tempfile::tempdir().unwrap();
    let local = temp.path().join("root");
    fs::create_dir(&local).unwrap();
    fs::write(local.join("keep.txt"), "retained").unwrap();
    let value = local.to_str().unwrap();
    let network =
        std::path::PathBuf::from(format!(r"\\localhost\{}$\{}", &value[..1], &value[3..]));
    let mut engine = Engine::new(&temp.path().join("journal"));
    engine.register("space", &network);
    let result = engine.mutate(&id(), "space", "keep.txt", json!({"kind":"trash"}));
    assert_eq!(result["error"], "FILE_UNSUPPORTED", "{result}");
    assert_eq!(
        fs::read_to_string(local.join("keep.txt")).unwrap(),
        "retained"
    );
}

#[test]
#[ignore = "requires access to the local administrative SMB share"]
fn local_to_smb_move_copies_before_recycling_and_keeps_a_recoverable_source() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let target = temp.path().join("target");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&target).unwrap();
    fs::write(source.join("note.txt"), "retained").unwrap();
    let value = target.to_str().unwrap();
    let network =
        std::path::PathBuf::from(format!(r"\\localhost\{}$\{}", &value[..1], &value[3..]));
    let mut engine = Engine::new(&temp.path().join("journal"));
    engine.register("source", &source);
    engine.register("target", &network);
    let result = engine.mutate(
        &id(),
        "source",
        "note.txt",
        json!({"kind":"move", "destinationRoot":"target", "destination":"moved.txt"}),
    );
    assert_eq!(result["result"]["status"], "applied", "{result}");
    assert_eq!(result["result"]["receipt"]["destinationCommitted"], true);
    assert_eq!(
        fs::read_to_string(target.join("moved.txt")).unwrap(),
        "retained"
    );
    assert!(!source.join("note.txt").exists());
    let receipt = &result["result"]["receipt"];
    let mut item = trash::os_limited::list()
        .unwrap()
        .into_iter()
        .find(|item| item.id == std::ffi::OsStr::new(receipt["trashId"].as_str().unwrap()))
        .unwrap();
    assert_eq!(item.original_parent, source);
    item.name = "note.txt".into();
    trash::os_limited::restore_all([item]).unwrap();
    assert_eq!(
        fs::read_to_string(source.join("note.txt")).unwrap(),
        "retained"
    );
}

#[test]
#[ignore = "requires access to the local administrative SMB share"]
fn smb_to_local_move_does_not_copy_when_the_source_cannot_be_recycled() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let target = temp.path().join("target");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&target).unwrap();
    fs::write(source.join("note.txt"), "retained").unwrap();
    let value = source.to_str().unwrap();
    let network =
        std::path::PathBuf::from(format!(r"\\localhost\{}$\{}", &value[..1], &value[3..]));
    let mut engine = Engine::new(&temp.path().join("journal"));
    engine.register("source", &network);
    engine.register("target", &target);
    let result = engine.mutate(
        &id(),
        "source",
        "note.txt",
        json!({"kind":"move", "destinationRoot":"target", "destination":"moved.txt"}),
    );
    assert_eq!(result["result"]["status"], "not-applied", "{result}");
    assert_eq!(result["result"]["error"], "FILE_UNSUPPORTED");
    assert_eq!(
        fs::read_to_string(source.join("note.txt")).unwrap(),
        "retained"
    );
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
}
