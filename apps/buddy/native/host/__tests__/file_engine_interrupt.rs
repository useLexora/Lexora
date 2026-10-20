use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
    },
    time::{Duration, Instant},
};

const HELPER: &str = "file_engine::interruption::helper";
const DIRECTORY: &str = "LEXORA_FILE_TEST_DIRECTORY";
const CHECKPOINT: &str = "LEXORA_FILE_TEST_CHECKPOINT";
static REACHED: AtomicBool = AtomicBool::new(false);

pub(super) fn checkpoint(stage: &str) {
    if std::env::var(CHECKPOINT).as_deref() != Ok(stage) || REACHED.swap(true, Ordering::SeqCst) {
        return;
    }
    let directory = PathBuf::from(std::env::var_os(DIRECTORY).unwrap());
    std::fs::write(directory.join("checkpoint"), stage).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !directory.join("continue").exists() {
        assert!(Instant::now() < deadline, "Checkpoint was not resumed");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
#[ignore = "subprocess entry, invoked by interruption tests"]
fn helper() {
    let directory = PathBuf::from(std::env::var_os(DIRECTORY).unwrap());
    super::serve(&directory.join("journal")).unwrap();
}

struct Engine {
    child: Child,
    input: ChildStdin,
    output: Receiver<Value>,
    sequence: u64,
}

impl Engine {
    fn new(directory: &Path, stage: Option<&str>) -> Self {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", HELPER, "--ignored", "--nocapture"])
            .env(DIRECTORY, directory)
            .env_remove(CHECKPOINT)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Some(stage) = stage {
            command.env(CHECKPOINT, stage);
        }
        let mut child = command.spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str(&line) else {
                    continue;
                };
                if sender.send(value).is_err() {
                    break;
                }
            }
        });
        let mut engine = Self {
            child,
            input,
            output,
            sequence: 0,
        };
        assert_eq!(
            engine.output.recv_timeout(Duration::from_secs(10)).unwrap(),
            json!({"event":"ready","version":2})
        );
        assert!(
            engine
                .call(json!({"type":"register","key":"root","path":directory.join("root")}))
                .get("result")
                .is_some()
        );
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
            let value = self.output.recv_timeout(Duration::from_secs(10)).unwrap();
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

    fn kill(&mut self) {
        self.child.kill().unwrap();
        assert!(!self.child.wait().unwrap().success());
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn mutation(operation: &str, text: &str) -> Value {
    json!({"type":"mutate","request":{"operationId":operation,"root":"root","path":"note","action":{"kind":"write","text":text}}})
}

fn wait_for_checkpoint(directory: &Path, stage: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if std::fs::read_to_string(directory.join("checkpoint")).is_ok_and(|value| value == stage) {
            return;
        }
        assert!(Instant::now() < deadline, "Helper did not reach {stage}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn interrupted_write(stage: &str, expected: &str) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("note"), "original").unwrap();
    std::fs::write(root.join("note.backup"), "retained backup").unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    let request = mutation(&operation, "committed");
    let mut engine = Engine::new(directory.path(), Some(stage));
    engine.send(request.clone());
    wait_for_checkpoint(directory.path(), stage);
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        expected
    );
    engine.kill();
    drop(engine);
    let db =
        rusqlite::Connection::open(directory.path().join("journal/operations.sqlite")).unwrap();
    let record: String = db
        .query_row(
            "SELECT record FROM operations WHERE id=?",
            [&operation],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&record).unwrap()["status"],
        "executing"
    );
    drop(db);
    let mut engine = Engine::new(directory.path(), None);
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        expected
    );
    let unknown = engine.call(json!({"type":"query","operationId":operation}))["result"].clone();
    assert_eq!(unknown["status"], "needs-recovery");
    assert_eq!(unknown["error"], "FILE_OPERATION_INTERRUPTED");
    assert_eq!(engine.call(request.clone())["result"], unknown);
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        expected
    );
    assert_eq!(
        engine.call(mutation(&operation, "different"))["error"],
        "FILE_OPERATION_ID_CONFLICT"
    );
    assert_eq!(
        engine.call(mutation(&uuid::Uuid::new_v4().to_string(), "continued"))["result"]["status"],
        "applied"
    );
    assert_eq!(engine.call(request)["result"], unknown);
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        "continued"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("note.backup")).unwrap(),
        "retained backup"
    );
}

#[test]
fn killed_helper_before_side_effect_keeps_original_and_allows_a_new_operation() {
    interrupted_write("executing", "original");
}

#[test]
fn killed_helper_after_commit_keeps_new_content_without_replaying_the_old_operation() {
    interrupted_write("completed", "committed");
}

#[test]
fn cancellation_does_not_finish_an_inflight_commit_or_start_the_next_write_early() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("note"), "original").unwrap();
    let mut engine = Engine::new(directory.path(), Some("completed"));
    let operation = uuid::Uuid::new_v4().to_string();
    let first = engine.send(mutation(&operation, "committed"));
    wait_for_checkpoint(directory.path(), "completed");
    let cancel = engine.send(json!({"type":"cancel","operationId":operation}));
    let second = engine.send(mutation(&uuid::Uuid::new_v4().to_string(), "continued"));
    assert!(matches!(
        engine.output.recv_timeout(Duration::from_millis(100)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        "committed"
    );
    std::fs::write(directory.path().join("continue"), "").unwrap();
    assert_eq!(engine.response(first)["result"]["status"], "applied");
    assert_eq!(engine.response(cancel)["result"], Value::Null);
    assert_eq!(engine.response(second)["result"]["status"], "applied");
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        "continued"
    );
}
