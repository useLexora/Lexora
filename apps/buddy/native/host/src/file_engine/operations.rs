use super::{
    io,
    journal::{Journal, now},
    protocol::{Action, Error, MAX_TEXT, Mutation, Operation, Result, Status},
    resources::{Claim, Root, Roots, contains, identity, relative},
    trash,
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};

pub fn claims(roots: &Roots, request: &Mutation) -> Result<Vec<Claim>> {
    let root = roots.get(&request.root)?;
    let mut claims = vec![root.claim(&request.path, true)?];
    if let Action::WriteFile {
        staging_root,
        staging_path,
        ..
    } = &request.action
    {
        claims.push(roots.get(staging_root)?.claim(staging_path, false)?);
    }
    let target = match &request.action {
        Action::Rename { destination } => Some((root.clone(), destination)),
        Action::Copy {
            destination_root,
            destination,
        }
        | Action::Move {
            destination_root,
            destination,
        } => Some((roots.get(destination_root)?, destination)),
        _ => None,
    };
    if let Some((target, path)) = target {
        let claim = target.claim(path, true)?;
        if contains(&claims[0].path, &claim.path) && claims[0].path != claim.path {
            return Err(Error::Invalid);
        }
        claims.push(claim);
    }
    Ok(claims)
}

pub fn query(
    journal: &Journal,
    operation_id: &str,
    request: Option<&Mutation>,
) -> Result<Option<Operation>> {
    let Some((previous, record)) = journal.find(operation_id)? else {
        return Ok(None);
    };
    if let Some(request) = request {
        let mut content = request.clone();
        content.lease_id = None;
        if request.operation_id != operation_id
            || previous != io::digest(&serde_json::to_vec(&content)?)
        {
            return Err(Error::IdConflict);
        }
    }
    Ok(Some(record))
}

pub fn execute(
    roots: &Roots,
    journal: &mut Journal,
    request: &Mutation,
    claims: &[Claim],
    cancelled: &Arc<AtomicBool>,
    progress: &dyn Fn(u64),
) -> Result<Operation> {
    let mut content = request.clone();
    content.lease_id = None;
    let fingerprint = io::digest(&serde_json::to_vec(&content)?);
    if let Some((previous, record)) = journal.find(&request.operation_id)? {
        if previous != fingerprint {
            return Err(Error::IdConflict);
        }
        return Ok(record);
    }
    if uuid::Uuid::parse_str(&request.operation_id).is_err() || request.path.is_empty() {
        return Err(Error::Invalid);
    }
    relative(&request.path)?;
    let root = roots.get(&request.root)?;
    #[cfg(windows)]
    let _source_parents =
        crate::windows_fs::ParentGuard::new(&root.path.join(relative(&request.path)?))?;
    io::check(&root, cancelled)?;
    let source = root.resolve(&request.path)?;
    let mut record = Operation {
        operation_id: request.operation_id.clone(),
        kind: serde_json::to_value(&request.action)?["kind"]
            .as_str()
            .ok_or(Error::Invalid)?
            .into(),
        source: source.to_string_lossy().into_owned(),
        destination: None,
        status: Status::Prepared,
        error: None,
        created_at: now(),
        updated_at: now(),
        receipt: None,
    };
    let target = match &request.action {
        Action::Rename { destination } => Some((root.clone(), destination.as_str())),
        Action::Copy {
            destination_root,
            destination,
        }
        | Action::Move {
            destination_root,
            destination,
        } => Some((roots.get(destination_root)?, destination.as_str())),
        _ => None,
    };
    #[cfg(windows)]
    let _target_parents = target
        .as_ref()
        .map(|(target, path)| -> Result<_> {
            Ok(crate::windows_fs::ParentGuard::new(
                &target.path.join(relative(path)?),
            )?)
        })
        .transpose()?;
    if let Some((target, path)) = &target {
        if path.is_empty() {
            return Err(Error::Invalid);
        }
        record.destination = Some(target.resolve(path)?.to_string_lossy().into_owned());
    }
    let existing = match root.dir.symlink_metadata(&request.path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if existing
        .as_ref()
        .is_some_and(|metadata| metadata.is_symlink())
    {
        return Err(Error::Unsupported);
    }
    let case_alias = if let Action::Rename { destination } = &request.action {
        is_case_alias(&root, &request.path, destination)?
    } else {
        false
    };
    if let Some((target, path)) = &target {
        let same_name = matches!(request.action, Action::Rename { .. })
            && (request.path == *path || case_alias);
        if target.dir.symlink_metadata(path).is_ok() && !same_name {
            return Err(Error::Conflict);
        }
    }
    let old = if let Action::Write { text, expected } = &request.action {
        if text.len() > MAX_TEXT || text.contains('\0') {
            return Err(Error::Unsupported);
        }
        if existing.is_some() {
            let value = io::read(&root, &request.path)?;
            if expected
                .as_ref()
                .is_some_and(|expected| value["etag"] != *expected)
            {
                return Err(Error::Conflict);
            }
            Some(value["text"].as_str().ok_or(Error::Invalid)?.to_owned())
        } else {
            if expected.is_some() {
                return Err(Error::Conflict);
            }
            None
        }
    } else {
        None
    };
    let binary = if let Action::WriteFile {
        staging_root,
        staging_path,
        size,
        sha256,
        expected,
    } = &request.action
    {
        let staged = roots.get(staging_root)?;
        io::check(&staged, cancelled)?;
        let bytes = io::read_bytes(&staged, staging_path)?;
        if bytes.len() as u64 != *size || io::digest(&bytes) != *sha256 {
            return Err(Error::Invalid);
        }
        let previous = if existing.is_some() {
            let previous = io::read_bytes(&root, &request.path)?;
            if expected.as_deref() != Some(io::digest(&previous).as_str()) {
                return Err(Error::Conflict);
            }
            Some(previous)
        } else {
            if expected.is_some() {
                return Err(Error::Conflict);
            }
            None
        };
        Some((previous, bytes))
    } else {
        None
    };
    match &request.action {
        Action::CreateFile | Action::CreateDirectory | Action::Restore { .. }
            if existing.is_some() =>
        {
            return Err(Error::Conflict);
        }
        Action::Rename { .. } | Action::Copy { .. } | Action::Move { .. } | Action::Trash
            if existing.is_none() =>
        {
            return Err(Error::Conflict);
        }
        _ => (),
    }
    let expected_identity = existing.as_ref().map(identity).transpose()?;
    if let Some(identity) = &expected_identity {
        record.receipt = Some(json!({ "sourceIdentity": identity }));
    }
    let staging = match &request.action {
        Action::CreateFile | Action::Write { .. } | Action::WriteFile { .. }
            if existing.is_none() =>
        {
            Some(sibling(
                &request.path,
                &format!(".lexora-{}.stage", request.operation_id),
            )?)
        }
        Action::Copy { .. } | Action::Move { .. } => target
            .as_ref()
            .map(|(_, destination)| {
                sibling(
                    destination,
                    &format!(".lexora-{}.copy", request.operation_id),
                )
            })
            .transpose()?,
        Action::Rename { .. } => Some(sibling(
            &request.path,
            &format!(".lexora-{}.rename", request.operation_id),
        )?),
        _ => None,
    };
    if let Some(staging) = staging {
        let staging_root = target.as_ref().map_or(&root, |(root, _)| root);
        record.receipt.get_or_insert_with(|| json!({}))["staging"] =
            json!(staging_root.resolve(&staging)?);
    }
    #[cfg(windows)]
    if matches!(request.action, Action::Trash) {
        super::windows_shell::validate_trash_path(&source)?;
    }
    journal.prepare(&fingerprint, &record, claims)?;
    if let Err(error) = io::check(&root, cancelled) {
        record.status = Status::NotApplied;
        record.error = Some(error.to_string());
        journal.update(&mut record)?;
        return Ok(record);
    }
    record.status = Status::Executing;
    journal.update(&mut record)?;
    #[cfg(test)]
    super::interruption::checkpoint("executing");
    let mut may_have_changes = false;
    let result: Result<Value> = (|| {
        if let Some(metadata) = &existing
            && identity(&root.dir.symlink_metadata(&request.path)?)? != identity(metadata)?
        {
            return Err(Error::Conflict);
        }
        match &request.action {
            Action::Write { text, .. } => {
                if let Some(old) = old {
                    crate::file_writer::write_large(&crate::file_writer::WriteRequest {
                        root: root.path.to_string_lossy().into_owned(),
                        path: source
                            .components()
                            .collect::<std::path::PathBuf>()
                            .to_string_lossy()
                            .into_owned(),
                        expected: old,
                        content: text.clone(),
                    })
                    .map_err(|error| match error {
                        crate::file_writer::WriteError::Conflict => Error::Conflict,
                        crate::file_writer::WriteError::Failed => {
                            Error::NotApplied(Box::new(Error::Io(std::io::Error::other(error))))
                        }
                        crate::file_writer::WriteError::OutcomeUnknown => Error::Recovery,
                    })?;
                } else {
                    let relative = relative(&request.path)?;
                    if let Some(parent) = relative
                        .parent()
                        .filter(|path| !path.as_os_str().is_empty())
                    {
                        may_have_changes = true;
                        root.dir.create_dir_all(parent)?;
                        io::sync_dir(&root.dir)?;
                    }
                    io::create_text(&root, &request.path, text, &request.operation_id)?;
                }
                Ok(json!({ "etag": io::digest(text.as_bytes()) }))
            }
            Action::WriteFile {
                staging_root,
                sha256,
                ..
            } => {
                io::check(roots.get(staging_root)?.as_ref(), cancelled)?;
                let (previous, bytes) = binary.as_ref().ok_or(Error::Invalid)?;
                if let Some(previous) = previous {
                    crate::file_writer::write_bytes(&crate::file_writer::WriteBytesRequest {
                        root: &root.path.to_string_lossy(),
                        path: &source
                            .components()
                            .collect::<std::path::PathBuf>()
                            .to_string_lossy(),
                        expected: previous,
                        content: bytes,
                    })
                    .map_err(|error| match error {
                        crate::file_writer::WriteError::Conflict => Error::Conflict,
                        crate::file_writer::WriteError::Failed => {
                            Error::NotApplied(Box::new(Error::Io(std::io::Error::other(error))))
                        }
                        crate::file_writer::WriteError::OutcomeUnknown => Error::Recovery,
                    })?;
                } else {
                    io::create_bytes(&root, &request.path, bytes, &request.operation_id)?;
                }
                Ok(json!({ "etag": sha256 }))
            }
            Action::CreateFile => {
                io::create_text(&root, &request.path, "", &request.operation_id)?;
                Ok(json!({}))
            }
            Action::CreateDirectory => {
                root.dir
                    .create_dir(&request.path)
                    .map_err(io::creation_error)?;
                may_have_changes = true;
                let path = relative(&request.path)?;
                io::sync_dir(
                    &root.dir.open_dir(
                        path.parent()
                            .filter(|path| !path.as_os_str().is_empty())
                            .unwrap_or(Path::new(".")),
                    )?,
                )?;
                Ok(json!({}))
            }
            Action::Rename { destination } => {
                if request.path == *destination {
                    return Ok(json!({}));
                }
                if case_alias {
                    let temporary = sibling(
                        &request.path,
                        &format!(".lexora-{}.rename", request.operation_id),
                    )?;
                    io::move_entry(
                        &root,
                        &request.path,
                        &root,
                        &temporary,
                        expected_identity.as_deref(),
                    )?;
                    may_have_changes = true;
                    io::move_entry(
                        &root,
                        &temporary,
                        &root,
                        destination,
                        expected_identity.as_deref(),
                    )?;
                } else {
                    io::move_entry(
                        &root,
                        &request.path,
                        &root,
                        destination,
                        expected_identity.as_deref(),
                    )?;
                }
                Ok(json!({}))
            }
            Action::Copy { .. } | Action::Move { .. } => {
                let (target, destination) = target.as_ref().ok_or(Error::Invalid)?;
                let moving = matches!(request.action, Action::Move { .. });
                if moving {
                    match io::move_entry(
                        &root,
                        &request.path,
                        target,
                        destination,
                        expected_identity.as_deref(),
                    ) {
                        Ok(()) => return Ok(json!({})),
                        Err(Error::Io(error))
                            if error.kind() == std::io::ErrorKind::CrossesDevices =>
                        {
                            #[cfg(windows)]
                            super::windows_shell::validate_trash_path(&source)?;
                        }
                        Err(error) => return Err(error),
                    }
                }
                let temporary = sibling(
                    destination,
                    &format!(".lexora-{}.copy", request.operation_id),
                )?;
                let source_fingerprint = io::tree_fingerprint(&root, &request.path, cancelled)
                    .map_err(|error| Error::NotApplied(Box::new(error)))?;
                may_have_changes = true;
                io::copy_entry(
                    &root,
                    &request.path,
                    target,
                    &temporary,
                    cancelled,
                    progress,
                )?;
                io::check(&root, cancelled)?;
                if io::tree_fingerprint(&root, &request.path, cancelled)? != source_fingerprint {
                    return Err(Error::Recovery);
                }
                io::move_entry(target, &temporary, target, destination, None)?;
                record.receipt.get_or_insert_with(|| json!({}))["destinationCommitted"] =
                    json!(true);
                journal.update(&mut record)?;
                if moving {
                    return trash::trash(
                        &source,
                        expected_identity.as_deref().ok_or(Error::Conflict)?,
                    );
                }
                Ok(json!({}))
            }
            Action::Trash => trash::trash(
                &source,
                expected_identity.as_deref().ok_or(Error::Conflict)?,
            ),
            Action::Restore {
                original_operation_id,
            } => {
                let (_, mut original) =
                    journal.find(original_operation_id)?.ok_or(Error::Invalid)?;
                if original.status != Status::Applied
                    || original.kind != "trash"
                    || original.source != record.source
                {
                    return Err(Error::Invalid);
                }
                if original
                    .receipt
                    .as_ref()
                    .is_some_and(|receipt| receipt.get("restoredBy").is_some())
                {
                    return Err(Error::Conflict);
                }
                trash::restore(
                    &root,
                    &request.path,
                    original.receipt.as_ref().ok_or(Error::Unsupported)?,
                )?;
                original.receipt.get_or_insert_with(|| json!({}))["restoredBy"] =
                    json!(request.operation_id);
                journal.update(&mut original)?;
                Ok(json!({ "restoredOperationId": original_operation_id }))
            }
        }
    })();
    #[cfg(test)]
    super::interruption::checkpoint("completed");
    match result {
        Ok(receipt) => {
            record.status = Status::Applied;
            let merged = record.receipt.get_or_insert_with(|| json!({}));
            if let (Some(target), Some(receipt)) = (merged.as_object_mut(), receipt.as_object()) {
                target.extend(receipt.clone());
            }
        }
        Err(error) => {
            record.status = if matches!(
                error,
                Error::Conflict | Error::Unsupported | Error::NotApplied(_)
            ) && !may_have_changes
            {
                Status::NotApplied
            } else {
                Status::NeedsRecovery
            };
            record.error = Some(error.to_string());
        }
    }
    journal.update(&mut record)?;
    Ok(record)
}

fn sibling(path: &str, name: &str) -> Result<String> {
    let path = relative(path)?;
    let parent = path.parent().unwrap_or(Path::new(""));
    Ok(parent.join(name).to_string_lossy().replace('\\', "/"))
}

fn is_case_alias(root: &Root, source: &str, destination: &str) -> Result<bool> {
    if source == destination || !same_case_name(source, destination) {
        return Ok(false);
    }
    let Ok(target) = root.dir.symlink_metadata(destination) else {
        return Ok(false);
    };
    if identity(&root.dir.symlink_metadata(source)?)? != identity(&target)? {
        return Ok(false);
    }
    let path = relative(source)?;
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(Error::Invalid)?;
    let mut matches = 0;
    for entry in root.dir.open_dir(parent)?.entries()? {
        if entry?
            .file_name()
            .to_str()
            .is_some_and(|entry| same_case_name(entry, name))
        {
            matches += 1;
        }
    }
    Ok(matches == 1)
}

fn same_case_name(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        crate::windows_fs::eq_ignore_case(left, right)
    }
    #[cfg(not(windows))]
    {
        left.eq_ignore_ascii_case(right)
    }
}
