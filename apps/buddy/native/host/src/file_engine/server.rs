use super::{
    io,
    journal::Journal,
    operations,
    protocol::{Command, Error, MAX_FRAME, Request, Result, Status, VERSION},
    resources::{Claim, Roots, contains, identity, overlap, path_key},
};
use notify::{RecursiveMode, Watcher};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

type Output = Arc<Mutex<std::io::Stdout>>;

#[derive(Default)]
struct Controls {
    roots: HashMap<String, Arc<AtomicBool>>,
    cancellations: HashMap<String, Arc<AtomicBool>>,
}

impl Controls {
    fn cancellation(&mut self, id: &str) -> Arc<AtomicBool> {
        self.cancellations.entry(id.to_owned()).or_default().clone()
    }
}

enum Input {
    Request(Request),
    Closed,
}

pub fn serve(directory: &Path) -> Result<()> {
    let journal = Journal::open(directory)?;
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let controls = Arc::new(Mutex::new(Controls::default()));
    let (sender, receiver) = mpsc::sync_channel(256);
    let reader_sender = sender.clone();
    let reader_controls = controls.clone();
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(std::io::stdin());
        loop {
            let mut frame = Vec::new();
            let read = std::io::Read::by_ref(&mut reader)
                .take(MAX_FRAME as u64 + 1)
                .read_until(b'\n', &mut frame);
            if !matches!(read, Ok(size) if size > 0 && size <= MAX_FRAME) {
                break;
            }
            let Ok(request) = serde_json::from_slice::<Request>(&frame) else {
                break;
            };
            if let Ok(mut controls) = reader_controls.lock() {
                match &request.command {
                    Command::Cancel { operation_id } => controls
                        .cancellation(operation_id)
                        .store(true, Ordering::SeqCst),
                    Command::Revoke { key } => controls
                        .roots
                        .entry(key.clone())
                        .or_default()
                        .store(true, Ordering::SeqCst),
                    _ => (),
                }
            } else {
                break;
            }
            if reader_sender.send(Input::Request(request)).is_err() {
                return;
            }
        }
        let _ = reader_sender.send(Input::Closed);
    });
    let changed = Arc::new(Mutex::new(Vec::new()));
    let watcher_changes = changed.clone();
    let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if result
            .as_ref()
            .is_ok_and(|event| matches!(event.kind, notify::EventKind::Access(_)))
        {
            return;
        }
        if let Ok(mut changes) = watcher_changes.lock() {
            if changes.len() >= 256 {
                changes.clear();
                changes.push(std::path::PathBuf::new());
            } else {
                changes.extend(
                    result
                        .map(|event| event.paths)
                        .unwrap_or_else(|_| vec![std::path::PathBuf::new()]),
                );
            }
        }
    })
    .ok();
    let mut engine = Engine {
        roots: Roots::default(),
        journal,
        controls,
        output,
        watcher,
        subscriptions: HashSet::new(),
        watched: HashMap::new(),
        pending: VecDeque::new(),
        active_leases: HashMap::new(),
    };
    send(
        &engine.output,
        json!({ "event": "ready", "version": VERSION }),
    )?;
    loop {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(Input::Request(request)) => {
                if matches!(request.command, Command::Shutdown) {
                    send(&engine.output, json!({ "id": request.id, "result": null }))?;
                    break;
                }
                if !engine.dispatch(&request)? {
                    engine.pending.push_back(request);
                }
                let mut remaining = VecDeque::new();
                while let Some(request) = engine.pending.pop_front() {
                    if !engine.dispatch(&request)? {
                        remaining.push_back(request);
                    }
                }
                engine.pending = remaining;
            }
            Ok(Input::Closed) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => (),
        }
        let paths = std::mem::take(&mut *changed.lock().map_err(|_| Error::Recovery)?);
        if !paths.is_empty() {
            let keys: Vec<_> = engine
                .roots
                .0
                .iter()
                .filter(|(key, root)| {
                    engine.subscriptions.contains(*key)
                        && !root.revoked.load(Ordering::SeqCst)
                        && paths
                            .iter()
                            .any(|path| path.as_os_str().is_empty() || path.starts_with(&root.path))
                })
                .map(|(key, _)| key.clone())
                .collect();
            if !keys.is_empty() {
                send(&engine.output, json!({"event":"changed","roots":keys}))?;
            }
        }
    }
    Ok(())
}

struct Engine {
    roots: Roots,
    journal: Journal,
    controls: Arc<Mutex<Controls>>,
    output: Output,
    watcher: Option<notify::RecommendedWatcher>,
    subscriptions: HashSet<String>,
    watched: HashMap<PathBuf, String>,
    pending: VecDeque<Request>,
    active_leases: HashMap<String, Vec<Claim>>,
}

impl Engine {
    fn watch_directory(&mut self, key: &str, path: &str) -> Result<()> {
        if !self.subscriptions.contains(key) {
            return Ok(());
        }
        let root = self.roots.get(key)?;
        let directory = root.resolve(path)?;
        let Some(watcher) = &mut self.watcher else {
            return Ok(());
        };
        for directory in directory
            .ancestors()
            .take_while(|path| path.starts_with(&root.path))
        {
            let relative = directory
                .strip_prefix(&root.path)
                .map_err(|_| Error::Invalid)?;
            let dir = root.dir.open_dir(if relative.as_os_str().is_empty() {
                Path::new(".")
            } else {
                relative
            })?;
            let current = identity(&dir.dir_metadata()?)?;
            if self.watched.get(directory) == Some(&current) {
                continue;
            }
            if self.watched.remove(directory).is_some() {
                let _ = watcher.unwatch(directory);
            }
            if watcher
                .watch(directory, RecursiveMode::NonRecursive)
                .is_ok()
            {
                self.watched.insert(directory.to_owned(), current);
            }
        }
        root.check()
    }

    fn revoke_watch(&mut self, key: &str) {
        self.subscriptions.remove(key);
        self.watched.retain(|path, _| {
            let retained = self.subscriptions.iter().any(|key| {
                self.roots.0.get(key).is_some_and(|root| {
                    !root.revoked.load(Ordering::SeqCst) && path.starts_with(&root.path)
                })
            });
            if !retained && let Some(watcher) = &mut self.watcher {
                let _ = watcher.unwatch(path);
            }
            retained
        });
    }

    fn dispatch(&mut self, request: &Request) -> Result<bool> {
        match self.handle(&request.command) {
            Ok(Some(result)) => send(&self.output, json!({ "id": request.id, "result": result }))?,
            Ok(None) => return Ok(false),
            Err(error) => send(
                &self.output,
                json!({ "id": request.id, "error": error.to_string() }),
            )?,
        }
        Ok(true)
    }

    fn available(&self, claims: &[Claim], own: Option<&str>) -> Result<bool> {
        if let Some(id) = own {
            let lease = self.active_leases.get(id).ok_or(Error::Lease)?;
            if !claims.iter().all(|claim| {
                lease.iter().any(|held| {
                    held.path == "*"
                        || held.path == claim.path
                        || (held.subtree && contains(&held.path, &claim.path))
                })
            }) {
                return Err(Error::Lease);
            }
        }
        for (id, held) in &self.active_leases {
            if Some(id.as_str()) != own && overlap(claims, held) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn handle(&mut self, command: &Command) -> Result<Option<Value>> {
        let result = match command {
            Command::Register { key, path, watch } => {
                let revoked = self
                    .controls
                    .lock()
                    .map_err(|_| Error::Recovery)?
                    .roots
                    .entry(key.clone())
                    .or_default()
                    .clone();
                let root = self.roots.register(key.clone(), path.clone(), revoked)?;
                if *watch {
                    self.subscriptions.insert(key.clone());
                    self.watch_directory(key, "")?;
                }
                json!({ "identity": root.identity, "path": root.path })
            }
            Command::Revoke { key } => {
                if let Some(root) = self.roots.0.get(key) {
                    root.revoked.store(true, Ordering::SeqCst);
                }
                self.revoke_watch(key);
                Value::Null
            }
            Command::List { root, path, cursor } => {
                self.watch_directory(root, path)?;
                io::list(self.roots.get(root)?.as_ref(), path, cursor.as_deref())?
            }
            Command::Read { root, path } => {
                let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent);
                self.watch_directory(root, parent)?;
                io::read(self.roots.get(root)?.as_ref(), path)?
            }
            Command::Acquire {
                lease_id,
                claims,
                external,
            } => {
                if uuid::Uuid::parse_str(lease_id).is_err() {
                    return Err(Error::Invalid);
                }
                if self
                    .journal
                    .leases()?
                    .iter()
                    .any(|(id, _, _)| id == lease_id)
                {
                    return Err(Error::Lease);
                }
                let claims = self.roots.claims(claims)?;
                if !self.available(&claims, None)? {
                    return Ok(None);
                }
                self.journal.acquire(lease_id, &claims, *external)?;
                self.active_leases.insert(lease_id.clone(), claims);
                Value::Null
            }
            Command::Protect { lease_id, claims } => {
                if uuid::Uuid::parse_str(lease_id).is_err() || claims.len() > 128 {
                    return Err(Error::Invalid);
                }
                let claims = claims
                    .iter()
                    .map(|claim| {
                        let path = Path::new(&claim.path);
                        if claim.path != "*"
                            && (!path.is_absolute()
                                || claim.path.contains('\0')
                                || path
                                    .components()
                                    .any(|part| matches!(part, std::path::Component::ParentDir)))
                        {
                            return Err(Error::Invalid);
                        }
                        Ok(Claim {
                            path: path_key(path),
                            subtree: claim.subtree,
                            object: None,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                self.journal.protect(lease_id, &claims)?;
                Value::Null
            }
            Command::Release { lease_id, hazard } => {
                let mut retained = VecDeque::new();
                while let Some(request) = self.pending.pop_front() {
                    if matches!(&request.command, Command::Acquire { lease_id: id, .. } if id == lease_id)
                    {
                        send(
                            &self.output,
                            json!({"id": request.id, "error": "FILE_OPERATION_CANCELLED"}),
                        )?;
                    } else {
                        retained.push_back(request);
                    }
                }
                self.pending = retained;
                self.active_leases.remove(lease_id);
                self.journal.release(lease_id, *hazard)?;
                Value::Null
            }
            Command::Leases => serde_json::to_value(
                self.journal
                    .leases()?
                    .into_iter()
                    .map(|(id, _, _)| id)
                    .collect::<Vec<_>>(),
            )?,
            Command::Mutate { request } => {
                self.roots.get(&request.root)?;
                let mut normalized = request.clone();
                normalized.lease_id = None;
                if let Some((fingerprint, record)) = self.journal.find(&request.operation_id)? {
                    if fingerprint != io::digest(&serde_json::to_vec(&normalized)?) {
                        return Err(Error::IdConflict);
                    }
                    return Ok(Some(serde_json::to_value(record)?));
                }
                let claims = operations::claims(&self.roots, request)?;
                if !self.available(&claims, request.lease_id.as_deref())? {
                    return Ok(None);
                }
                let cancelled = self
                    .controls
                    .lock()
                    .map_err(|_| Error::Recovery)?
                    .cancellation(&request.operation_id);
                let output = self.output.clone();
                let operation_id = request.operation_id.clone();
                let progress = |bytes: u64| {
                    let _ = send(
                        &output,
                        json!({ "event": "progress", "operationId": operation_id, "bytes": bytes }),
                    );
                };
                let record = operations::execute(
                    &self.roots,
                    &mut self.journal,
                    request,
                    &claims,
                    &cancelled,
                    &progress,
                );
                self.controls
                    .lock()
                    .map_err(|_| Error::Recovery)?
                    .cancellations
                    .remove(&request.operation_id);
                let record = record?;
                send(
                    &self.output,
                    json!({ "event": "operation", "operation": record }),
                )?;
                serde_json::to_value(record)?
            }
            Command::Query { operation_id } => {
                serde_json::to_value(self.journal.find(operation_id)?.map(|(_, record)| record))?
            }
            Command::History { root } => {
                let root = self.roots.get(root)?;
                serde_json::to_value(self.journal.history(&path_key(&root.path))?)?
            }
            Command::Acknowledge { root, operation_id } => {
                if uuid::Uuid::parse_str(operation_id).is_err() {
                    return Err(Error::Invalid);
                }
                let root = self.roots.get(root)?;
                let (_, mut record) = self.journal.find(operation_id)?.ok_or(Error::Invalid)?;
                if !matches!(record.status, Status::NeedsRecovery | Status::Acknowledged) {
                    return Err(Error::Invalid);
                }
                let staging = record
                    .receipt
                    .as_ref()
                    .and_then(|receipt| receipt.get("staging"))
                    .map(|value| value.as_str().ok_or(Error::Invalid))
                    .transpose()?;
                for path in std::iter::once(record.source.as_str())
                    .chain(record.destination.as_deref())
                    .chain(staging)
                {
                    root.check_recorded_path(path)?;
                }
                root.check()?;
                if record.status == Status::NeedsRecovery {
                    record.status = Status::Acknowledged;
                    self.journal.update(&mut record)?;
                }
                serde_json::to_value(record)?
            }
            Command::Cancel { operation_id } => {
                let mut retained = VecDeque::new();
                while let Some(request) = self.pending.pop_front() {
                    if matches!(&request.command, Command::Mutate { request } if &request.operation_id == operation_id)
                    {
                        send(
                            &self.output,
                            json!({"id":request.id,"error":"FILE_OPERATION_CANCELLED"}),
                        )?;
                    } else {
                        retained.push_back(request);
                    }
                }
                self.pending = retained;
                Value::Null
            }
            Command::Shutdown => Value::Null,
        };
        Ok(Some(result))
    }
}

fn send(output: &Output, value: Value) -> Result<()> {
    let mut writer = output.lock().map_err(|_| Error::Recovery)?;
    serde_json::to_writer(&mut *writer, &value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}
