use super::{Engine, id};
use serde_json::{Value, json};

fn interrupt(journal: &std::path::Path, records: &mut [Value]) {
    let db = rusqlite::Connection::open(journal.join("operations.sqlite")).unwrap();
    for record in records {
        record["status"] = json!("executing");
        db.execute(
            "UPDATE operations SET record=?,status=? WHERE id=?",
            rusqlite::params![
                record.to_string(),
                "\"executing\"",
                record["operationId"].as_str().unwrap()
            ],
        )
        .unwrap();
    }
}

#[test]
fn legacy_unknown_records_and_protection_remain_diagnostic_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let journal = directory.path().join("journal");
    std::fs::create_dir(&root).unwrap();
    #[cfg(unix)]
    let root = {
        let alias = directory.path().join("root-alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        alias
    };
    let mut engine = Engine::new(&journal);
    engine.register("root", &root);
    let operation = id();
    let mut record = engine.mutate(
        &operation,
        "root",
        "note",
        json!({"kind":"write", "text":"retained"}),
    )["result"]
        .clone();
    assert_eq!(record["status"], "applied");
    drop(engine);
    interrupt(&journal, std::slice::from_mut(&mut record));
    let db = rusqlite::Connection::open(journal.join("operations.sqlite")).unwrap();
    db.execute_batch("PRAGMA user_version=1").unwrap();
    let source = record["source"].as_str().unwrap().replace('\\', "/");
    let (parent, name) = source.rsplit_once('/').unwrap();
    let legacy_path = format!("{parent}/./{name}");
    db.execute(
        "UPDATE operations SET claims=? WHERE id=?",
        rusqlite::params![
            json!([{"path":legacy_path,"subtree":true,"object":null}]).to_string(),
            operation
        ],
    )
    .unwrap();
    drop(db);

    let lease = id();
    let protection =
        json!({"type":"protect", "leaseId":lease, "claims":[{"path":source,"subtree":false}]});
    let mut engine = Engine::new(&journal);
    engine.register("root", &root);
    assert_eq!(engine.call(protection.clone())["result"], Value::Null);
    assert_eq!(engine.call(protection.clone())["result"], Value::Null);
    assert_eq!(
        engine.call(json!({"type":"leases"}))["result"],
        json!([lease])
    );
    drop(engine);
    let db = rusqlite::Connection::open(journal.join("operations.sqlite")).unwrap();
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        2
    );
    drop(db);

    let mut engine = Engine::new(&journal);
    engine.register("root", &root);
    assert_eq!(engine.call(protection)["result"], Value::Null);
    let unknown = engine.call(json!({"type":"query", "operationId":operation}))["result"].clone();
    assert_eq!(unknown["status"], "needs-recovery");
    assert_eq!(engine.call(json!({"type":"mutate", "request":{"operationId":id(), "leaseId":lease, "root":"root", "path":"note", "action":{"kind":"write","text":"unsafe"}}}))["error"], "FILE_LEASE_INVALID");
    assert_eq!(
        engine.mutate(
            &id(),
            "root",
            "note",
            json!({"kind":"write","text":"allowed"})
        )["result"]["status"],
        "applied"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        "allowed"
    );
    assert_eq!(
        engine.mutate(
            &operation,
            "root",
            "note",
            json!({"kind":"write","text":"retained"})
        )["result"],
        unknown
    );
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        "allowed"
    );
    assert_eq!(
        engine.call(json!({"type":"leases"}))["result"],
        json!([lease])
    );
}

#[test]
fn protection_does_not_release_or_expand_an_active_lease() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("note"), "original").unwrap();
    let mut engine = Engine::new(&directory.path().join("journal"));
    engine.register("root", &root);
    let lease = id();
    assert_eq!(engine.call(json!({"type":"acquire","leaseId":lease,"external":true,"claims":[{"root":"root","path":"note","subtree":false}]}))["result"], Value::Null);
    assert_eq!(
        engine.call(
            json!({"type":"protect","leaseId":lease,"claims":[{"path":root,"subtree":true}]})
        )["result"],
        Value::Null
    );
    assert_eq!(engine.call(json!({"type":"mutate","request":{"operationId":id(),"leaseId":lease,"root":"root","path":"other","action":{"kind":"write","text":"invalid"}}}))["error"], "FILE_LEASE_INVALID");
    let operation = id();
    let queued = engine.send(json!({"type":"mutate","request":{"operationId":operation,"root":"root","path":"note","action":{"kind":"write","text":"continued"}}}));
    let query = engine.send(json!({"type":"query","operationId":operation}));
    assert_eq!(engine.response(query)["result"], Value::Null);
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        "original"
    );
    let release = engine.send(json!({"type":"release","leaseId":lease,"hazard":true}));
    assert_eq!(engine.response(release)["result"], Value::Null);
    assert_eq!(engine.response(queued)["result"]["status"], "applied");
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        "continued"
    );
    assert_eq!(
        engine.call(json!({"type":"leases"}))["result"],
        json!([lease])
    );
    assert_eq!(engine.call(json!({"type":"mutate","request":{"operationId":id(),"leaseId":lease,"root":"root","path":"note","action":{"kind":"write","text":"invalid"}}}))["error"], "FILE_LEASE_INVALID");
    assert!(!root.join("other").exists());
}

#[test]
fn restart_retains_external_lease_diagnostics_without_restoring_ownership() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let journal = directory.path().join("journal");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("note"), "original").unwrap();
    let old = id();
    let mut engine = Engine::new(&journal);
    engine.register("root", &root);
    assert_eq!(engine.call(json!({"type":"acquire","leaseId":old,"external":true,"claims":[{"root":"root","path":"note","subtree":false}]}))["result"], Value::Null);
    drop(engine);
    let mut engine = Engine::new(&journal);
    engine.register("root", &root);
    assert_eq!(
        engine.call(json!({"type":"leases"}))["result"],
        json!([old])
    );
    assert_eq!(engine.call(json!({"type":"mutate","request":{"operationId":id(),"leaseId":old,"root":"root","path":"note","action":{"kind":"write","text":"invalid"}}}))["error"], "FILE_LEASE_INVALID");
    let fresh = id();
    assert_eq!(engine.call(json!({"type":"acquire","leaseId":fresh,"external":true,"claims":[{"root":"root","path":"note","subtree":false}]}))["result"], Value::Null);
    assert_eq!(engine.call(json!({"type":"mutate","request":{"operationId":id(),"leaseId":fresh,"root":"root","path":"note","action":{"kind":"write","text":"continued"}}}))["result"]["status"], "applied");
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        "continued"
    );
    assert_eq!(
        engine.call(json!({"type":"release","leaseId":fresh,"hazard":false}))["result"],
        Value::Null
    );
    drop(engine);
    let db = rusqlite::Connection::open(journal.join("operations.sqlite")).unwrap();
    let hazard: bool = db
        .query_row("SELECT hazard FROM leases WHERE id=?", [&old], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(hazard);
}

#[test]
fn protection_preserves_prior_claims_and_does_not_require_paths_to_exist() {
    let directory = tempfile::tempdir().unwrap();
    let journal = directory.path().join("journal");
    let lease = id();
    let mut engine = Engine::new(&journal);
    let missing = directory.path().join("missing");
    for path in [
        missing.join("first"),
        missing.join("second"),
        missing.join("first"),
    ] {
        assert_eq!(
            engine.call(
                json!({"type":"protect", "leaseId":lease, "claims":[{"path":path,"subtree":true}]})
            )["result"],
            Value::Null
        );
    }
    drop(engine);
    let db = rusqlite::Connection::open(journal.join("operations.sqlite")).unwrap();
    let (claims, hazard, external): (String, bool, bool) = db
        .query_row(
            "SELECT claims,hazard,external FROM leases WHERE id=?",
            [&lease],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&claims)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(hazard && external);
    assert!(!missing.exists());
}

#[cfg(unix)]
#[test]
fn acknowledgement_rejects_replaced_root_without_blocking_a_new_capability() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let journal = directory.path().join("journal");
    std::fs::create_dir(&root).unwrap();
    let mut engine = Engine::new(&journal);
    engine.register("root", &root);
    let operation = id();
    let mut record = engine.mutate(
        &operation,
        "root",
        "note",
        json!({"kind":"write","text":"original"}),
    )["result"]
        .clone();
    drop(engine);
    interrupt(&journal, std::slice::from_mut(&mut record));
    let mut engine = Engine::new(&journal);
    engine.register("root", &root);
    assert_eq!(
        engine.call(json!({"type":"history","root":"root"}))["result"][0]["status"],
        "needs-recovery"
    );
    let retained = directory.path().join("retained");
    std::fs::rename(&root, &retained).unwrap();
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("note"), "replacement").unwrap();
    assert_eq!(
        engine.call(json!({"type":"acknowledge","root":"root","operationId":operation}))["error"],
        "FILE_PERMISSION_REVOKED"
    );
    assert_eq!(
        engine.call(json!({"type":"query","operationId":operation}))["result"]["status"],
        "needs-recovery"
    );
    engine.register("replacement-probe", &root);
    assert_eq!(
        engine.mutate(
            &id(),
            "replacement-probe",
            "note",
            json!({"kind":"write","text":"allowed"})
        )["result"]["status"],
        "applied"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        "allowed"
    );
    assert_eq!(
        std::fs::read_to_string(retained.join("note")).unwrap(),
        "original"
    );
}

#[test]
fn acknowledgement_requires_source_destination_and_staging_in_the_bound_root() {
    for endpoint in ["source", "destination", "staging"] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        let journal = directory.path().join("journal");
        std::fs::create_dir(&root).unwrap();
        let mut engine = Engine::new(&journal);
        engine.register("root", &root);
        let operation = id();
        let mut record = engine.mutate(
            &operation,
            "root",
            "note",
            json!({"kind":"write","text":"retained"}),
        )["result"]
            .clone();
        drop(engine);
        let outside = directory.path().join("outside");
        std::fs::write(&outside, "outside").unwrap();
        if endpoint == "staging" {
            record["receipt"]["staging"] = json!(outside);
        } else {
            record[endpoint] = json!(outside);
        }
        interrupt(&journal, std::slice::from_mut(&mut record));
        let mut engine = Engine::new(&journal);
        engine.register("root", &root);
        assert_eq!(
            engine.call(json!({"type":"acknowledge","root":"root","operationId":operation}))["error"],
            "FILE_PERMISSION_REVOKED",
            "{endpoint}"
        );
        assert_eq!(
            engine.call(json!({"type":"query","operationId":operation}))["result"]["status"],
            "needs-recovery"
        );
        assert_eq!(
            engine.mutate(
                &id(),
                "root",
                "note",
                json!({"kind":"write","text":"allowed"})
            )["result"]["status"],
            "applied"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("note")).unwrap(),
            "allowed"
        );
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "outside");
    }
}

#[cfg(unix)]
#[test]
fn rejected_creation_has_no_recovery_hazard_or_temporary_file() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let mut engine = Engine::new(&directory.path().join("journal"));
    engine.register("root", &root);
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o555)).unwrap();
    let file = engine.mutate(&id(), "root", "file", json!({"kind":"createFile"}));
    let folder = engine.mutate(&id(), "root", "folder", json!({"kind":"createDirectory"}));
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
    for result in [file, folder] {
        assert_eq!(result["result"]["status"], "not-applied", "{result}");
        assert_eq!(result["result"]["error"], "FILE_IO_FAILED", "{result}");
    }
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    assert_eq!(
        engine.mutate(&id(), "root", "file", json!({"kind":"createFile"}))["result"]["status"],
        "applied"
    );
}

#[test]
fn rejected_hardlink_save_preserves_both_files_without_poisoning_later_writes() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let path = root.join("note.txt");
    let alias = root.join("alias.txt");
    std::fs::write(&path, "original").unwrap();
    std::fs::hard_link(&path, &alias).unwrap();
    let mut engine = Engine::new(&directory.path().join("journal"));
    engine.register("root", &root);
    let rejected = engine.mutate(
        &id(),
        "root",
        "note.txt",
        json!({"kind":"write","text":"rejected"}),
    );
    assert_eq!(rejected["result"]["status"], "not-applied", "{rejected}");
    assert_eq!(rejected["result"]["error"], "FILE_IO_FAILED", "{rejected}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
    assert_eq!(std::fs::read_to_string(&alias).unwrap(), "original");
    std::fs::remove_file(alias).unwrap();
    let continued = engine.mutate(
        &id(),
        "root",
        "note.txt",
        json!({"kind":"write","text":"continued"}),
    );
    assert_eq!(continued["result"]["status"], "applied", "{continued}");
    assert_eq!(std::fs::read_to_string(path).unwrap(), "continued");
}

#[test]
fn occupied_staging_file_is_preserved_and_does_not_create_a_hazard() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let operation = id();
    let staging = root.join(format!(".lexora-{operation}.stage"));
    std::fs::write(&staging, "foreign").unwrap();
    let mut engine = Engine::new(&directory.path().join("journal"));
    engine.register("root", &root);
    let result = engine.mutate(&operation, "root", "file", json!({"kind":"createFile"}));
    assert_eq!(result["result"]["status"], "not-applied", "{result}");
    assert_eq!(std::fs::read_to_string(staging).unwrap(), "foreign");
    assert!(!root.join("file").exists());
}
