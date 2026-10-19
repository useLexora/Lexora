use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    ptr,
};

use serde::{Deserialize, Serialize};
use windows_sys::Win32::{
    Security::Authorization::DENY_ACCESS,
    Storage::FileSystem::{
        CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_WRITE,
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    },
};

use super::{
    account::Account,
    cancellation::Cancellation,
    filesystem::{self, Access, AclLock, Grant},
    security::{SecurityDescriptor, boolean, owned, sid_text, unique_id, wide},
    setup,
};
use crate::windows_security::Sid;

const STATE_LIMIT: u64 = 32 * 1024 * 1024;

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    roots: BTreeMap<String, Root>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Root {
    grant: Grant,
    principals: Vec<String>,
}

fn key(grant: &Grant) -> String {
    format!(
        "{}:{}:{}",
        grant.path.to_uppercase(),
        grant.device,
        grant.inode
    )
}

fn ledger_path(owner: &Sid) -> io::Result<PathBuf> {
    let executable = setup::installed_path()?;
    let directory = executable.parent().ok_or(io::ErrorKind::InvalidData)?;
    setup::protected_object(directory)?;
    Ok(directory.join(format!("acl-state-v1-{}.json", sid_text(owner)?)))
}

fn read<T: for<'de> Deserialize<'de> + Default>(path: &Path, protected: bool) -> io::Result<T> {
    if protected {
        match setup::protected_object(path) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(T::default()),
            Err(error) => return Err(error),
        }
    }
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(T::default()),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(STATE_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > STATE_LIMIT {
        return Err(io::ErrorKind::InvalidData.into());
    }
    serde_json::from_slice(&bytes).map_err(io::Error::from)
}

pub(super) fn publish(path: &Path, bytes: &[u8], protected: bool) -> io::Result<()> {
    if bytes.len() as u64 > STATE_LIMIT {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let _parent = if protected {
        Some(setup::protected_object(
            path.parent().ok_or(io::ErrorKind::InvalidInput)?,
        )?)
    } else {
        None
    };
    let pending = path.with_extension(format!("{}.pending-state", unique_id()?));
    let result = (|| {
        let mut file = if protected {
            let descriptor = SecurityDescriptor::new("O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)")?;
            let attributes = descriptor.attributes(false);
            // SAFETY: The fresh temporary file is administrator/SYSTEM-only from creation, under a verified protected parent.
            File::from(owned(unsafe {
                CreateFileW(
                    wide(&pending.to_string_lossy()).as_ptr(),
                    FILE_GENERIC_WRITE,
                    0,
                    &attributes,
                    CREATE_NEW,
                    FILE_ATTRIBUTE_NORMAL,
                    ptr::null_mut(),
                )
            })?)
        } else {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&pending)?
        };
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        // SAFETY: Both paths are in the same protected or host-private directory; publication is atomic and durable.
        boolean(unsafe {
            MoveFileExW(
                wide(&pending.to_string_lossy()).as_ptr(),
                wide(&path.to_string_lossy()).as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(pending);
    }
    result
}

// The service records intent before the ordinary-user supervisor changes any ACL.
pub(super) fn remember(owner: &Sid, account: &Account, grants: &[Grant]) -> io::Result<()> {
    if grants.len() > 1024 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let path = ledger_path(owner)?;
    let mut ledger: Ledger = read(&path, true)?;
    let owner = sid_text(owner)?;
    let capabilities: Vec<_> = grants
        .iter()
        .filter(|grant| matches!(grant.access, Access::Write))
        .map(|grant| (grant, filesystem::capability(&owner, grant)))
        .collect();
    let mut changed = false;
    for grant in grants {
        if !crate::windows_path::valid(&grant.path) || grant.path.starts_with(r"\\") {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let principals = match grant.access {
            Access::Read | Access::DenyRead => vec![account.sid.clone()],
            Access::Write => vec![
                account.group_sid.clone(),
                filesystem::capability(&owner, grant),
            ],
            Access::DenyWrite => capabilities
                .iter()
                .filter(|(root, _)| super::policy::contains(&root.path, &grant.path))
                .map(|(_, sid)| sid.clone())
                .collect(),
        };
        if principals.is_empty() {
            continue;
        }
        let root = ledger.roots.entry(key(grant)).or_insert_with(|| {
            changed = true;
            let mut grant = grant.clone();
            grant.exceptions.clear();
            Root {
                grant,
                principals: Vec::new(),
            }
        });
        if grant.inherit && !root.grant.inherit {
            root.grant.inherit = true;
            changed = true;
        }
        for principal in principals {
            if !root.principals.contains(&principal) {
                root.principals.push(principal);
                changed = true;
            }
        }
    }
    if changed {
        publish(&path, &serde_json::to_vec(&ledger)?, true)?;
    }
    Ok(())
}

pub(super) fn discard_unpublished() -> io::Result<()> {
    let executable = setup::installed_path()?;
    let directory = executable.parent().ok_or(io::ErrorKind::InvalidData)?;
    let _directory = setup::protected_object(directory)?;
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "pending-state")
        {
            setup::protected_object(&path)?;
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

pub(super) fn cleanup(principals: Option<&[String]>) -> io::Result<()> {
    let executable = setup::installed_path()?;
    let directory = executable.parent().ok_or(io::ErrorKind::InvalidData)?;
    let _directory = setup::protected_object(directory)?;
    let mut remaining = 0;
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("acl-state-v1-S-1-") || !name.ends_with(".json") {
            continue;
        }
        let mut ledger: Ledger = read(&path, true)?;
        for root in ledger.roots.values_mut() {
            if principals.is_some_and(|selected| {
                !root
                    .principals
                    .iter()
                    .any(|principal| selected.contains(principal))
            }) {
                continue;
            }
            let file = filesystem::open_grant(&root.grant);
            root.principals.retain(|principal| {
                if principals.is_some_and(|selected| !selected.contains(principal)) {
                    return true;
                }
                let result = file
                    .as_ref()
                    .map_err(|error| {
                        io::Error::new(error.kind(), "Recorded ACL root is unavailable")
                    })
                    .and_then(|file| {
                        filesystem::revoke_owned(
                            file,
                            &super::account::parse_sid(principal)?,
                            false,
                            root.grant.inherit,
                        )
                    });
                if result.is_err() {
                    remaining += 1;
                    true
                } else {
                    false
                }
            });
        }
        ledger.roots.retain(|_, root| !root.principals.is_empty());
        if ledger.roots.is_empty() {
            fs::remove_file(path)?;
        } else {
            publish(&path, &serde_json::to_vec(&ledger)?, true)?;
        }
    }
    if remaining != 0 {
        eprintln!(
            "{}",
            serde_json::json!({"type":"diagnostic","phase":"acl_cleanup_incomplete","remaining":remaining,"nativeCode":null})
        );
    }
    Ok(())
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DenialScope {
    principal: String,
    roots: BTreeMap<String, Grant>,
}

type Denials = BTreeMap<String, DenialScope>;

pub(super) enum DenialUpdate<'a> {
    Merge(&'a str),
    Replace(&'a str),
}

pub(super) fn update_denials(
    update: DenialUpdate<'_>,
    principal: &Sid,
    grants: &[Grant],
    cancellation: &Cancellation,
) -> io::Result<()> {
    let scope = match update {
        DenialUpdate::Merge(scope) | DenialUpdate::Replace(scope) => scope,
    };
    if scope.is_empty() || scope.len() > 4096 || grants.len() > 1024 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    if matches!(update, DenialUpdate::Merge(_)) && grants.is_empty() {
        return Ok(());
    }
    let _lock = AclLock::for_denials(cancellation)?;
    let path = filesystem::journal_directory()?.join("denials-v1.json");
    reconcile(&path, update, principal, grants, cancellation)
}

fn reconcile(
    path: &Path,
    update: DenialUpdate<'_>,
    principal: &Sid,
    grants: &[Grant],
    cancellation: &Cancellation,
) -> io::Result<()> {
    let (scope, replace) = match update {
        DenialUpdate::Merge(scope) => (scope.to_uppercase(), false),
        DenialUpdate::Replace(scope) => (scope.to_uppercase(), true),
    };
    let mut state: Denials = read(path, false)?;
    let principal_text = sid_text(principal)?;
    let previous = state
        .get(&scope)
        .filter(|old| old.principal == principal_text)
        .cloned()
        .unwrap_or_default();
    let mut desired = if replace {
        BTreeMap::new()
    } else {
        previous.roots.clone()
    };
    desired.extend(grants.iter().map(|grant| (key(grant), grant.clone())));
    if desired.is_empty() && previous.roots.is_empty() {
        return Ok(());
    }
    let mut intent = previous.roots.clone();
    intent.extend(desired.clone());
    let changed = state
        .get(&scope)
        .is_none_or(|old| old.principal != principal_text || old.roots.keys().ne(intent.keys()));
    state.insert(
        scope.to_owned(),
        DenialScope {
            principal: principal_text.clone(),
            roots: intent,
        },
    );
    if changed {
        publish(path, &serde_json::to_vec(&state)?, false)?;
    }
    for grant in grants {
        cancellation.check()?;
        let file = filesystem::open_grant(grant)?;
        filesystem::ensure_acl(
            grant,
            &file,
            principal,
            filesystem::denial_mask(grant.access)?,
            DENY_ACCESS,
            cancellation,
        )?;
    }
    for (key, grant) in &previous.roots {
        cancellation.check()?;
        if desired.contains_key(key)
            || state.iter().any(|(other, entry)| {
                other != &scope
                    && entry.principal == principal_text
                    && entry.roots.contains_key(key)
            })
        {
            continue;
        }
        let _lock = AclLock::for_root(grant, cancellation)?;
        match filesystem::open_grant(grant) {
            Ok(file) => filesystem::revoke_owned(&file, principal, true, grant.inherit)?,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::InvalidInput
                ) => {}
            Err(error) => return Err(error),
        }
    }
    let removed = previous.roots.keys().ne(desired.keys());
    if desired.is_empty() {
        state.remove(&scope);
    } else {
        state.insert(
            scope.to_owned(),
            DenialScope {
                principal: principal_text,
                roots: desired,
            },
        );
    }
    if removed {
        publish(path, &serde_json::to_vec(&state)?, false)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../__tests__/shell_sandbox_acl_state.rs"]
mod tests;
