use super::{
    protocol::{Error, MAX_TEXT, Result},
    resources::{Root, identity, relative},
};
use cap_std::fs::{Dir, OpenOptions};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn read(root: &Root, path: &str) -> Result<Value> {
    root.resolve(path)?;
    let path = relative(path)?;
    root.check()?;
    let file = open_regular(&root.dir, &path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_TEXT as u64 {
        return Err(Error::Unsupported);
    }
    let mut bytes = Vec::new();
    file.take(MAX_TEXT as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_TEXT || bytes.contains(&0) {
        return Err(Error::Unsupported);
    }
    root.check()?;
    let etag = digest(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| Error::Unsupported)?;
    Ok(json!({ "text": text, "etag": etag, "identity": identity(&metadata)? }))
}

pub fn list(root: &Root, path: &str, cursor: Option<&str>) -> Result<Value> {
    root.resolve(path)?;
    root.check()?;
    let dir = root
        .dir
        .open_dir(if path.is_empty() { "." } else { path })?;
    let mut entries = Vec::new();
    for entry in dir.entries()? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let entry_path = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}/{name}")
        };
        let metadata = root.dir.symlink_metadata(&entry_path);
        let (kind, unavailable, id) = match metadata {
            Ok(metadata) if metadata.is_file() || metadata.is_dir() => (
                if metadata.is_dir() {
                    "directory"
                } else {
                    "file"
                },
                false,
                identity(&metadata).ok(),
            ),
            _ => ("file", true, None),
        };
        entries.push(json!({ "name": name, "path": entry_path, "kind": kind, "unavailable": unavailable, "identity": id }));
    }
    entries.sort_by(|a, b| {
        (a["kind"] != "directory")
            .cmp(&(b["kind"] != "directory"))
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    let start = cursor
        .and_then(|cursor| entries.iter().position(|entry| entry["name"] == cursor))
        .map_or(0, |index| index + 1);
    let end = (start + 250).min(entries.len());
    let next = if end < entries.len() {
        entries[end - 1]["name"].clone()
    } else {
        Value::Null
    };
    root.check()?;
    Ok(json!({ "entries": &entries[start..end], "nextCursor": next }))
}

pub fn check(root: &Root, cancelled: &AtomicBool) -> Result<()> {
    root.check()?;
    if cancelled.load(Ordering::SeqCst) {
        return Err(Error::Cancelled);
    }
    Ok(())
}

pub fn sync_dir(_dir: &Dir) -> Result<()> {
    #[cfg(unix)]
    _dir.open(".")?.sync_all()?;
    Ok(())
}

pub fn create_text(root: &Root, path: &str, text: &str, id: &str) -> Result<()> {
    let path = relative(path)?;
    #[cfg(windows)]
    let _parents = crate::windows_fs::ParentGuard::new(&root.path.join(&path))
        .map_err(|error| Error::NotApplied(Box::new(error.into())))?;
    let temporary = format!(".lexora-{id}.stage");
    let parent = (|| -> Result<_> {
        let parent_path = path.parent().ok_or(Error::Invalid)?;
        Ok(root.dir.open_dir(if parent_path.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent_path
        })?)
    })()
    .map_err(|error| Error::NotApplied(Box::new(error)))?;
    let mut file = parent
        .open_with(&temporary, OpenOptions::new().write(true).create_new(true))
        .map_err(creation_error)?;
    (|| {
        let name = path.file_name().ok_or(Error::Invalid)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        root.check()?;
        rename_new(&parent, Path::new(&temporary), &parent, Path::new(name))?;
        sync_dir(&parent)
    })()
    .map_err(|_: Error| Error::Recovery)
}

pub fn creation_error(error: std::io::Error) -> Error {
    use std::io::ErrorKind;
    if matches!(
        error.kind(),
        ErrorKind::PermissionDenied
            | ErrorKind::AlreadyExists
            | ErrorKind::NotFound
            | ErrorKind::NotADirectory
            | ErrorKind::ReadOnlyFilesystem
            | ErrorKind::InvalidInput
    ) {
        Error::NotApplied(Box::new(error.into()))
    } else {
        Error::Io(error)
    }
}

pub fn rename_new(from: &Dir, source: &Path, to: &Dir, destination: &Path) -> Result<()> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        rustix::fs::renameat_with(
            from,
            source,
            to,
            destination,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(std::io::Error::from)?;
        Ok(())
    }
    #[cfg(windows)]
    {
        super::windows::rename_new(from, source, to, destination, None)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        Err(Error::Unsupported)
    }
}

pub fn move_entry(
    root: &Root,
    source: &str,
    target: &Root,
    destination: &str,
    expected: Option<&str>,
) -> Result<()> {
    let source = relative(source)?;
    let destination = relative(destination)?;
    let from = root.dir.open_dir(
        source
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?;
    let to = target.dir.open_dir(
        destination
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?;
    root.check()?;
    target.check()?;
    #[cfg(not(windows))]
    {
        if let Some(expected) = expected
            && identity(&from.symlink_metadata(source.file_name().ok_or(Error::Invalid)?)?)?
                != expected
        {
            return Err(Error::Conflict);
        }
        rename_new(
            &from,
            Path::new(source.file_name().ok_or(Error::Invalid)?),
            &to,
            Path::new(destination.file_name().ok_or(Error::Invalid)?),
        )?;
    }
    #[cfg(windows)]
    super::windows::rename_new(
        &from,
        Path::new(source.file_name().ok_or(Error::Invalid)?),
        &to,
        Path::new(destination.file_name().ok_or(Error::Invalid)?),
        expected,
    )?;
    sync_dir(&to)?;
    sync_dir(&from)
}

pub fn copy_entry(
    root: &Root,
    source: &str,
    target: &Root,
    destination: &str,
    cancelled: &Arc<AtomicBool>,
    progress: &dyn Fn(u64),
) -> Result<()> {
    let metadata = root.dir.symlink_metadata(source)?;
    check(root, cancelled)?;
    target.check()?;
    if metadata.is_symlink() {
        return Err(Error::Unsupported);
    }
    if metadata.is_dir() {
        target.dir.create_dir(destination)?;
        let dir = root.dir.open_dir(source)?;
        for entry in dir.entries()? {
            let name = entry?
                .file_name()
                .into_string()
                .map_err(|_| Error::Unsupported)?;
            copy_entry(
                root,
                &format!("{source}/{name}"),
                target,
                &format!("{destination}/{name}"),
                cancelled,
                progress,
            )?;
        }
        sync_dir(&target.dir.open_dir(destination)?)?;
    } else if metadata.is_file() {
        let mut input = open_regular(&root.dir, Path::new(source))?;
        if identity(&input.metadata()?)? != identity(&metadata)? {
            return Err(Error::Conflict);
        }
        let mut output = target
            .dir
            .open_with(destination, OpenOptions::new().write(true).create_new(true))?;
        let mut buffer = vec![0; 1024 * 1024];
        loop {
            check(root, cancelled)?;
            target.check()?;
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
            progress(count as u64);
        }
        let after = input.metadata()?;
        if after.len() != metadata.len() || after.modified()? != metadata.modified()? {
            return Err(Error::Conflict);
        }
        output.set_permissions(metadata.permissions())?;
        output.sync_all()?;
    } else {
        return Err(Error::Unsupported);
    }
    Ok(())
}

fn open_regular(dir: &Dir, path: &Path) -> Result<cap_std::fs::File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(
            (rustix::fs::OFlags::NONBLOCK | rustix::fs::OFlags::NOFOLLOW).bits() as i32,
        );
    }
    let file = dir.open_with(path, &options)?;
    if !file.metadata()?.is_file() {
        return Err(Error::Unsupported);
    }
    Ok(file)
}

pub fn tree_fingerprint(root: &Root, path: &str, cancelled: &AtomicBool) -> Result<String> {
    fn visit(root: &Root, path: &str, cancelled: &AtomicBool, hash: &mut Sha256) -> Result<()> {
        check(root, cancelled)?;
        let metadata = root.dir.symlink_metadata(path)?;
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update(identity(&metadata)?.as_bytes());
        hash.update([0]);
        if metadata.is_symlink() {
            return Err(Error::Unsupported);
        }
        if metadata.is_dir() {
            let mut names = root
                .dir
                .open_dir(path)?
                .entries()?
                .map(|entry| {
                    entry?
                        .file_name()
                        .into_string()
                        .map_err(|_| Error::Unsupported)
                })
                .collect::<Result<Vec<_>>>()?;
            names.sort();
            for name in names {
                visit(root, &format!("{path}/{name}"), cancelled, hash)?;
            }
        } else if metadata.is_file() {
            let mut file = open_regular(&root.dir, Path::new(path))?;
            let mut buffer = vec![0; 1024 * 1024];
            loop {
                check(root, cancelled)?;
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
        } else {
            return Err(Error::Unsupported);
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    visit(root, path, cancelled, &mut hash)?;
    Ok(format!("{:x}", hash.finalize()))
}
