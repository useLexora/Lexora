use super::*;

fn root(directory: &Path) -> PathBuf {
    let path = fs::canonicalize(directory).unwrap();
    let path = path.to_str().unwrap();
    PathBuf::from(path.strip_prefix(r"\\?\").unwrap())
}
fn request(root: &Path, path: &Path, operation: Operation, name: Option<&str>) -> MutationRequest {
    MutationRequest {
        root: root.to_str().unwrap().into(),
        path: path.to_str().unwrap().into(),
        operation,
        name: name.map(str::to_owned),
    }
}

#[test]
fn creates_empty_entries_and_never_overwrites() {
    let temp = tempfile::tempdir().unwrap();
    let root = root(temp.path());
    prepare(request(
        &root,
        &root,
        Operation::CreateFile,
        Some("note.md"),
    ))
    .unwrap()
    .commit()
    .unwrap();
    fs::write(root.join("note.md"), "keep").unwrap();
    assert!(matches!(
        prepare(request(
            &root,
            &root,
            Operation::CreateFile,
            Some("note.md")
        ))
        .unwrap()
        .commit(),
        Err(MutationError::Exists)
    ));
    assert_eq!(fs::read_to_string(root.join("note.md")).unwrap(), "keep");
    prepare(request(
        &root,
        &root,
        Operation::CreateDirectory,
        Some("folder"),
    ))
    .unwrap()
    .commit()
    .unwrap();
    assert!(root.join("folder").is_dir());
    assert!(
        prepare(request(
            &root,
            &root,
            Operation::CreateDirectory,
            Some("folder")
        ))
        .unwrap()
        .commit()
        .is_err()
    );
}

#[test]
fn creation_pins_empty_directory_ancestors_without_a_source_file() {
    let temp = tempfile::tempdir().unwrap();
    let root = root(temp.path());
    let parent = root.join("empty");
    fs::create_dir(&parent).unwrap();
    let prepared = prepare(request(
        &root,
        &parent,
        Operation::CreateFile,
        Some("new.md"),
    ))
    .unwrap();
    assert!(fs::rename(&parent, root.join("moved")).is_err());
    assert!(fs::remove_dir(&parent).is_err());
    prepared.commit().unwrap();
    assert_eq!(fs::read(parent.join("new.md")).unwrap(), b"");
}

#[test]
fn source_and_ancestors_cannot_be_replaced_while_prepared() {
    let temp = tempfile::tempdir().unwrap();
    let root = root(temp.path());
    fs::create_dir(root.join("folder")).unwrap();
    fs::write(root.join("folder/old.md"), "original").unwrap();
    let prepared = prepare(request(
        &root,
        &root.join("folder").join("old.md"),
        Operation::Rename,
        Some("new.md"),
    ))
    .unwrap();
    assert!(fs::rename(root.join("folder"), root.join("moved")).is_err());
    assert!(fs::rename(root.join("folder/old.md"), root.join("folder/replaced.md")).is_err());
    // A destination appearing after preparation still cannot be overwritten.
    fs::write(root.join("folder/new.md"), "destination").unwrap();
    assert!(matches!(prepared.commit(), Err(MutationError::Exists)));
    assert_eq!(
        fs::read_to_string(root.join("folder/old.md")).unwrap(),
        "original"
    );
    assert_eq!(
        fs::read_to_string(root.join("folder/new.md")).unwrap(),
        "destination"
    );
}

#[test]
fn renames_files_and_directories_by_identity_without_overwriting() {
    let temp = tempfile::tempdir().unwrap();
    let root = root(temp.path());
    fs::write(root.join("old.md"), "original").unwrap();
    prepare(request(
        &root,
        &root.join("old.md"),
        Operation::Rename,
        Some("new.md"),
    ))
    .unwrap()
    .commit()
    .unwrap();
    assert_eq!(fs::read_to_string(root.join("new.md")).unwrap(), "original");
    assert!(!root.join("old.md").exists());
    fs::create_dir(root.join("folder")).unwrap();
    fs::write(root.join("folder/child"), "child").unwrap();
    prepare(request(
        &root,
        &root.join("folder"),
        Operation::Rename,
        Some("renamed"),
    ))
    .unwrap()
    .commit()
    .unwrap();
    assert_eq!(
        fs::read_to_string(root.join("renamed/child")).unwrap(),
        "child"
    );
}

#[test]
fn rename_preserves_exact_unicode_names_at_every_buffer_alignment() {
    let temp = tempfile::tempdir().unwrap();
    let root = root(temp.path());
    for padding in 0..8 {
        let source = root.join(format!("source-{padding}.txt"));
        fs::write(&source, "original").unwrap();
        let name = format!("extracted1.txt操作📝{}", "x".repeat(padding));
        prepare(request(&root, &source, Operation::Rename, Some(&name)))
            .unwrap()
            .commit()
            .unwrap();
        assert!(
            root.join(&name).exists(),
            "expected exact name: {name:?}; actual: {:?}",
            fs::read_dir(&root)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>()
        );
        assert_eq!(fs::read_to_string(root.join(&name)).unwrap(), "original");
    }
}

#[test]
fn invalid_names_case_only_root_mutation_and_escapes_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let root = root(temp.path());
    fs::write(root.join("note.md"), "keep").unwrap();
    for name in [
        "", ".", "..", "a/b", "a\\b", "NUL", "CON.txt", "name.", "name ", "a:b",
    ] {
        assert!(
            prepare(request(&root, &root, Operation::CreateFile, Some(name))).is_err(),
            "{name}"
        );
    }
    assert!(matches!(
        prepare(request(
            &root,
            &root.join("note.md"),
            Operation::Rename,
            Some("NOTE.md")
        )),
        Err(MutationError::CaseOnly)
    ));
    for operation in [Operation::Rename, Operation::Trash] {
        assert!(
            prepare(request(
                &root,
                &root,
                operation,
                if operation == Operation::Rename {
                    Some("new")
                } else {
                    None
                }
            ))
            .is_err()
        );
    }
    assert!(
        prepare(request(
            &root,
            &root.parent().unwrap().join("outside"),
            Operation::CreateFile,
            Some("wrong")
        ))
        .is_err()
    );
    assert_eq!(fs::read_to_string(root.join("note.md")).unwrap(), "keep");
}

fn recycle_fixture(root: &Path, name: &str) -> (PreparedMutation, PathBuf, PathBuf) {
    let bin = root.join("fixture-bin");
    fs::create_dir(&bin).unwrap();
    // Use the real source/ancestor preparation; only the system bin destination is replaced
    // with a private test directory. Production never accepts a renderer-supplied bin path.
    let mut prepared = prepare(request(
        root,
        &root.join(name),
        Operation::Rename,
        Some("unused"),
    ))
    .unwrap();
    prepared.request.operation = Operation::Trash;
    prepared.destination = None;
    let destination = recycle::Destination::fixture(&bin).unwrap();
    let (record, payload) = destination.paths();
    let paths = (record.to_owned(), payload.to_owned());
    prepared.recycle = Some(destination);
    (prepared, paths.0, paths.1)
}

#[test]
fn recycle_keeps_source_and_bin_pinned_and_moves_original_by_handle() {
    let temp = tempfile::tempdir().unwrap();
    let root = root(temp.path());
    let name = "original-中文😀.md";
    fs::write(root.join(name), "original data").unwrap();
    let (prepared, record, payload) = recycle_fixture(&root, name);
    assert!(fs::rename(root.join(name), root.join("substitute.md")).is_err());
    assert!(fs::remove_file(root.join(name)).is_err());
    assert!(fs::rename(root.join("fixture-bin"), root.join("moved-bin")).is_err());
    prepared.commit().unwrap();
    assert!(!root.join(name).exists());
    assert_eq!(fs::read_to_string(payload).unwrap(), "original data");
    let metadata = fs::read(record).unwrap();
    assert_eq!(&metadata[..8], &2u64.to_le_bytes());
    assert_eq!(&metadata[8..16], &13u64.to_le_bytes());
    let original = root
        .join(name)
        .to_str()
        .unwrap()
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    assert_eq!(&metadata[24..28], &(original.len() as u32).to_le_bytes());
    assert_eq!(
        &metadata[28..],
        &original
            .iter()
            .flat_map(|unit| unit.to_le_bytes())
            .collect::<Vec<_>>()
    );
}

#[test]
fn recycle_payload_collision_preserves_both_files_and_cleans_only_own_record() {
    let temp = tempfile::tempdir().unwrap();
    let root = root(temp.path());
    fs::write(root.join("original.md"), "original").unwrap();
    let (prepared, record, payload) = recycle_fixture(&root, "original.md");
    fs::write(&payload, "existing payload").unwrap();
    assert!(matches!(prepared.commit(), Err(MutationError::Exists)));
    assert_eq!(
        fs::read_to_string(root.join("original.md")).unwrap(),
        "original"
    );
    assert_eq!(fs::read_to_string(payload).unwrap(), "existing payload");
    assert!(!record.exists());
}

#[test]
fn recycle_record_collision_never_overwrites_or_cleans_a_foreign_record() {
    let temp = tempfile::tempdir().unwrap();
    let root = root(temp.path());
    fs::write(root.join("original.md"), "original").unwrap();
    let (prepared, record, payload) = recycle_fixture(&root, "original.md");
    fs::write(&record, "existing metadata").unwrap();
    assert!(matches!(prepared.commit(), Err(MutationError::Exists)));
    assert_eq!(
        fs::read_to_string(root.join("original.md")).unwrap(),
        "original"
    );
    assert_eq!(fs::read_to_string(record).unwrap(), "existing metadata");
    assert!(!payload.exists());
}

#[test]
fn dropping_preparation_and_canceling_protocol_do_not_write() {
    let temp = tempfile::tempdir().unwrap();
    let root = root(temp.path());
    drop(
        prepare(request(
            &root,
            &root,
            Operation::CreateFile,
            Some("not-created"),
        ))
        .unwrap(),
    );
    assert!(!root.join("not-created").exists());
    let input = format!(
        "{{\"root\":{},\"path\":{},\"operation\":\"create-file\",\"name\":\"not-created\"}}\ncancel\n",
        serde_json::to_string(root.to_str().unwrap()).unwrap(),
        serde_json::to_string(root.to_str().unwrap()).unwrap()
    );
    let mut output = Vec::new();
    assert!(crate::file_mutation::run(std::io::Cursor::new(input), &mut output).is_err());
    assert_eq!(output, b"ready\n");
    assert!(!root.join("not-created").exists());
}

#[test]
fn path_casing_differences_resolve_to_the_same_entry() {
    let temp = tempfile::tempdir().unwrap();
    let root = root(temp.path());
    let stored = root.join("Case-Folder");
    fs::create_dir(&stored).unwrap();
    // NTFS resolves one directory whether the caller writes `Case-Folder`, `CASE-FOLDER` or
    // anything between; preparation must follow the filesystem instead of byte comparison.
    prepare(request(
        &root,
        &root.join("CASE-FOLDER"),
        Operation::CreateFile,
        Some("note.md"),
    ))
    .unwrap()
    .commit()
    .unwrap();
    assert_eq!(fs::read(stored.join("note.md")).unwrap(), b"");
    fs::write(stored.join("old.md"), "original").unwrap();
    prepare(request(
        &root,
        &root.join("cASE-fOLDER").join("OLD.MD"),
        Operation::Rename,
        Some("new.md"),
    ))
    .unwrap()
    .commit()
    .unwrap();
    assert_eq!(
        fs::read_to_string(stored.join("new.md")).unwrap(),
        "original"
    );
    assert!(!stored.join("old.md").exists());
}

#[test]
fn recycle_destination_pins_a_differently_cased_bin_directory() {
    let temp = tempfile::tempdir().unwrap();
    let root = root(temp.path());
    let stored = root.join("fixture-bin");
    fs::create_dir(&stored).unwrap();
    // Volumes whose Recycle Bin root is stored as `$RECYCLE.BIN` pin the bin through a spelling
    // that differs from the stored name; the destination must still be that same directory.
    let destination = recycle::Destination::fixture(&root.join("FIXTURE-BIN")).unwrap();
    let (record, payload) = destination.paths();
    fs::write(record, "metadata").unwrap();
    assert_eq!(
        fs::read_to_string(stored.join(record.file_name().unwrap())).unwrap(),
        "metadata"
    );
    assert!(
        payload
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("$R")
    );
}

#[test]
fn path_comparison_folds_ascii_case_only() {
    assert!(same_path(r"D:\$RECYCLE.BIN", r"D:\$Recycle.Bin"));
    assert!(same_path(r"C:\Users\Mixed", r"c:\users\MIXED"));
    assert!(!same_path(r"D:\one", r"D:\two"));
    assert!(!same_path(r"D:\dir", r"D:\dir\child"));
    // Non-ASCII casing is not folded: an unsupported case difference keeps failing closed.
    assert!(!same_path(r"D:\Ä", r"D:\ä"));
}
