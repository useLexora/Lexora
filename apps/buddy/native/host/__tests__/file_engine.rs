use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::Duration,
};

#[cfg(windows)]
static WINDOWS_ENGINE: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Engine {
    child: Child,
    input: ChildStdin,
    output: Receiver<Value>,
    sequence: u64,
    #[cfg(windows)]
    _windows_instance: std::sync::MutexGuard<'static, ()>,
}
impl Engine {
    fn new(journal: &Path) -> Self {
        #[cfg(windows)]
        let windows_instance = WINDOWS_ENGINE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut child = Command::new(env!("CARGO_BIN_EXE_lexora-buddy-file-reader"))
            .args(["--serve", journal.to_str().unwrap()])
            .env(
                "XDG_DATA_HOME",
                journal.parent().unwrap().join("trash-data"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if sender.send(serde_json::from_str(&line).unwrap()).is_err() {
                    break;
                }
            }
        });
        let engine = Self {
            child,
            input,
            output,
            sequence: 0,
            #[cfg(windows)]
            _windows_instance: windows_instance,
        };
        let ready = engine
            .output
            .recv_timeout(Duration::from_secs(10))
            .expect("File engine did not become ready");
        assert_eq!(ready, json!({"event":"ready", "version":1}));
        engine
    }
    fn send(&mut self, command: Value) -> u64 {
        self.sequence += 1;
        writeln!(
            self.input,
            "{}",
            json!({"id":self.sequence,"command":command})
        )
        .unwrap();
        self.sequence
    }
    fn response(&self, id: u64) -> Value {
        loop {
            let value = self
                .output
                .recv_timeout(Duration::from_secs(10))
                .unwrap_or_else(|error| panic!("File engine response {id} failed: {error}"));
            if value["id"] == id {
                return value;
            }
            assert!(value.get("event").is_some(), "Unexpected response: {value}");
        }
    }
    fn call(&mut self, command: Value) -> Value {
        let id = self.send(command);
        self.response(id)
    }
    fn register(&mut self, key: &str, path: &Path) {
        assert!(
            self.call(json!({"type":"register","key":key,"path":path}))
                .get("result")
                .is_some()
        );
    }
    fn mutate(&mut self, id: &str, root: &str, path: &str, action: Value) -> Value {
        self.call(json!({"type":"mutate","request":{"operationId":id,"root":root,"path":path,"action":action}}))
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[test]
fn journal_deduplicates_mutations_and_never_overwrites_a_destination() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let mut engine = Engine::new(&directory.path().join("journal"));
    engine.register("space", &root);
    let operation = id();
    let first = engine.mutate(
        &operation,
        "space",
        "note.md",
        json!({"kind":"write","text":"original"}),
    );
    assert_eq!(first["result"]["status"], "applied");
    std::fs::write(root.join("note.md"), "external").unwrap();
    assert_eq!(
        engine.mutate(
            &operation,
            "space",
            "note.md",
            json!({"kind":"write","text":"original"})
        )["result"],
        first["result"]
    );
    assert_eq!(
        std::fs::read_to_string(root.join("note.md")).unwrap(),
        "external"
    );
    assert_eq!(
        engine.mutate(
            &operation,
            "space",
            "note.md",
            json!({"kind":"write","text":"different"})
        )["error"],
        "FILE_OPERATION_ID_CONFLICT"
    );
    std::fs::write(root.join("occupied.md"), "retained").unwrap();
    let rename = engine.mutate(
        &id(),
        "space",
        "note.md",
        json!({"kind":"rename","destination":"occupied.md"}),
    );
    assert_ne!(rename["result"]["status"], "applied");
    assert_eq!(
        std::fs::read_to_string(root.join("occupied.md")).unwrap(),
        "retained"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("note.md")).unwrap(),
        "external"
    );
}

#[test]
fn existing_file_save_commits_and_rejects_stale_content() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("note.md"), "original").unwrap();
    let mut engine = Engine::new(&directory.path().join("journal"));
    engine.register("space", &root);
    let first = engine.mutate(
        &id(),
        "space",
        "note.md",
        json!({"kind":"write","text":"saved"}),
    );
    assert_eq!(first["result"]["status"], "applied", "{first}");
    assert_eq!(
        std::fs::read_to_string(root.join("note.md")).unwrap(),
        "saved"
    );
    let expected = &first["result"]["receipt"]["etag"];
    let second = engine.mutate(
        &id(),
        "space",
        "note.md",
        json!({"kind":"write","text":"updated","expected":expected}),
    );
    assert_eq!(second["result"]["status"], "applied", "{second}");
    let stale = engine.mutate(
        &id(),
        "space",
        "note.md",
        json!({"kind":"write","text":"stale","expected":expected}),
    );
    assert_eq!(stale["error"], "FILE_CONFLICT", "{stale}");
    assert_eq!(
        std::fs::read_to_string(root.join("note.md")).unwrap(),
        "updated"
    );
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn shared_roots_and_hardlinks_share_the_same_resource_lease() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("a"), "content").unwrap();
    std::fs::hard_link(root.join("a"), root.join("alias")).unwrap();
    let mut engine = Engine::new(&directory.path().join("journal"));
    engine.register("one", &root);
    engine.register("two", &root);
    let lease = id();
    assert_eq!(engine.call(json!({"type":"acquire","leaseId":lease,"external":false,"claims":[{"root":"one","path":"a","subtree":false}]}))["result"], Value::Null);
    let queued = engine.send(json!({"type":"mutate","request":{"operationId":id(),"root":"two","path":"alias","action":{"kind":"rename","destination":"moved"}}}));
    let release = engine.send(json!({"type":"release","leaseId":lease,"hazard":false}));
    assert_eq!(engine.response(release)["result"], Value::Null);
    assert_eq!(engine.response(queued)["result"]["status"], "applied");
    assert!(root.join("a").exists());
    assert!(!root.join("alias").exists());
    assert!(root.join("moved").exists());
}

#[test]
fn restart_preserves_unknown_outcomes_and_blocks_replay_until_reviewed() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let journal = directory.path().join("journal");
    let operation = id();
    let mut engine = Engine::new(&journal);
    engine.register("root", &root);
    let mut record =
        engine.mutate(&operation, "root", "a", json!({"kind":"createFile"}))["result"].clone();
    assert_eq!(record["status"], "applied");
    drop(engine);
    let db = rusqlite::Connection::open(journal.join("operations.sqlite")).unwrap();
    record["status"] = json!("executing");
    db.execute(
        "UPDATE operations SET record=?,status=? WHERE id=?",
        rusqlite::params![record.to_string(), "\"executing\"", operation],
    )
    .unwrap();
    drop(db);
    let mut engine = Engine::new(&journal);
    engine.register("root", &root);
    assert_eq!(
        engine.call(json!({"type":"query","operationId":operation}))["result"]["status"],
        "needs-recovery"
    );
    assert_eq!(
        engine.mutate(&operation, "root", "a", json!({"kind":"createFile"}))["result"]["status"],
        "needs-recovery"
    );
    assert_eq!(
        engine.mutate(
            &id(),
            "root",
            "a",
            json!({"kind":"rename","destination":"b"})
        )["error"],
        "FILE_RECOVERY_REQUIRED"
    );
    assert!(root.join("a").exists());
    assert!(!root.join("b").exists());
    assert_eq!(
        engine.call(json!({"type":"acknowledge","operationId":operation}))["result"]["status"],
        "acknowledged"
    );
    assert_eq!(
        engine.mutate(
            &id(),
            "root",
            "a",
            json!({"kind":"rename","destination":"b"})
        )["result"]["status"],
        "applied"
    );
}

#[cfg(unix)]
#[test]
fn capabilities_reject_symlink_escape_and_revoked_roots() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(directory.path().join("outside"), "private").unwrap();
    std::os::unix::fs::symlink(directory.path(), root.join("escape")).unwrap();
    std::fs::create_dir(root.join("inside")).unwrap();
    std::fs::write(root.join("inside/local"), "retained").unwrap();
    std::os::unix::fs::symlink(root.join("inside"), root.join("alias")).unwrap();
    let mut engine = Engine::new(&directory.path().join("journal"));
    engine.register("root", &root);
    assert!(
        engine
            .call(json!({"type":"read","root":"root","path":"alias/local"}))
            .get("error")
            .is_some()
    );
    assert!(
        engine
            .mutate(&id(), "root", "alias/local", json!({"kind":"trash"}))
            .get("error")
            .is_some()
    );
    assert_eq!(
        std::fs::read(root.join("inside/local")).unwrap(),
        b"retained"
    );
    let result = engine.mutate(
        &id(),
        "root",
        "escape/outside",
        json!({"kind":"write","text":"wrong"}),
    );
    assert!(result.get("error").is_some());
    assert_eq!(
        std::fs::read_to_string(directory.path().join("outside")).unwrap(),
        "private"
    );
    engine.call(json!({"type":"revoke","key":"root"}));
    assert_eq!(
        engine.mutate(&id(), "root", "new", json!({"kind":"createFile"}))["error"],
        "FILE_PERMISSION_REVOKED"
    );
    assert!(!root.join("new").exists());
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn system_trash_receipts_restore_once_and_preserve_colliding_files() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("note"), "recoverable").unwrap();
    let mut engine = Engine::new(&directory.path().join("journal"));
    engine.register("root", &root);
    let trash = id();
    assert_eq!(
        engine.mutate(&trash, "root", "note", json!({"kind":"trash"}))["result"]["status"],
        "applied"
    );
    assert!(!root.join("note").exists());
    std::fs::write(root.join("note"), "new file").unwrap();
    assert_eq!(
        engine.mutate(
            &id(),
            "root",
            "note",
            json!({"kind":"restore","originalOperationId":trash})
        )["error"],
        "FILE_CONFLICT"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        "new file"
    );
    std::fs::remove_file(root.join("note")).unwrap();
    assert_eq!(
        engine.mutate(
            &id(),
            "root",
            "note",
            json!({"kind":"restore","originalOperationId":trash})
        )["result"]["status"],
        "applied"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        "recoverable"
    );
}

#[test]
fn copy_commits_the_complete_tree_and_preserves_occupied_targets() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir_all(root.join("source/nested")).unwrap();
    std::fs::write(root.join("source/a"), "first").unwrap();
    std::fs::write(root.join("source/nested/b"), "second").unwrap();
    let mut engine = Engine::new(&directory.path().join("journal"));
    engine.register("root", &root);
    let result = engine.mutate(
        &id(),
        "root",
        "source",
        json!({"kind":"copy","destinationRoot":"root","destination":"target"}),
    );
    assert_eq!(result["result"]["status"], "applied", "{result}");
    assert_eq!(std::fs::read(root.join("target/a")).unwrap(), b"first");
    assert_eq!(
        std::fs::read(root.join("target/nested/b")).unwrap(),
        b"second"
    );
    assert!(root.join("source/nested/b").exists());
    let conflict = engine.mutate(
        &id(),
        "root",
        "source/a",
        json!({"kind":"copy","destinationRoot":"root","destination":"target/nested/b"}),
    );
    assert_eq!(conflict["error"], "FILE_CONFLICT");
    assert_eq!(
        std::fs::read(root.join("target/nested/b")).unwrap(),
        b"second"
    );
}

#[test]
fn queued_mutation_can_be_cancelled_without_modifying_the_file() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("a"), "retained").unwrap();
    let mut engine = Engine::new(&directory.path().join("journal"));
    engine.register("root", &root);
    let lease = id();
    engine.call(json!({"type":"acquire","leaseId":lease,"external":false,"claims":[{"root":"root","path":"a","subtree":false}]}));
    let operation = id();
    let queued = engine.send(json!({"type":"mutate","request":{"operationId":operation,"root":"root","path":"a","action":{"kind":"trash"}}}));
    let cancel = engine.send(json!({"type":"cancel","operationId":operation}));
    assert_eq!(engine.response(queued)["error"], "FILE_OPERATION_CANCELLED");
    assert_eq!(engine.response(cancel)["result"], Value::Null);
    assert_eq!(std::fs::read(root.join("a")).unwrap(), b"retained");
}

#[cfg(windows)]
#[path = "file_engine_windows_protocol.rs"]
mod windows;

#[test]
fn browsed_directories_notify_shared_roots_after_revocation() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir_all(root.join("src/deep")).unwrap();
    std::fs::create_dir_all(root.join("unopened")).unwrap();
    std::fs::write(root.join("src/deep/note.txt"), "original").unwrap();
    let mut engine = Engine::new(&directory.path().join("journal"));
    for key in ["first", "second"] {
        assert!(
            engine
                .call(json!({"type":"register", "key":key, "path":root, "watch":true}))
                .get("result")
                .is_some()
        );
    }
    engine.register("agent", &root);
    let read = engine.call(json!({"type":"read", "root":"first", "path":"src/deep/note.txt"}));
    assert_eq!(read["result"]["text"], "original");
    while engine
        .output
        .recv_timeout(Duration::from_millis(300))
        .is_ok()
    {}
    std::fs::write(root.join("src/deep/note.txt"), "changed").unwrap();
    let change = engine.output.recv_timeout(Duration::from_secs(5)).unwrap();
    let roots = change["roots"].as_array().unwrap();
    assert_eq!(roots.len(), 2);
    assert!(roots.contains(&json!("first")) && roots.contains(&json!("second")));

    engine.call(json!({"type":"revoke", "key":"first"}));
    while engine
        .output
        .recv_timeout(Duration::from_millis(300))
        .is_ok()
    {}
    std::fs::write(root.join("src/deep/note.txt"), "after revoke").unwrap();
    let change = engine.output.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(change["roots"], json!(["second"]));
    assert_eq!(
        engine.call(json!({"type":"read", "root":"first", "path":"src/deep/note.txt"}))["error"],
        "FILE_PERMISSION_REVOKED"
    );

    engine.call(json!({"type":"list", "root":"second", "path":"unopened"}));
    while engine
        .output
        .recv_timeout(Duration::from_millis(300))
        .is_ok()
    {}
    std::fs::write(root.join("unopened/new.txt"), "now browsed").unwrap();
    let change = engine.output.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(change["roots"], json!(["second"]));
}
