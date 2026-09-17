use super::{ReadError, ReadRequest};
use rustix::fs::{CWD, Mode, OFlags, getpath, openat};
use std::{
    fs::File,
    io::Read,
    os::unix::ffi::OsStrExt,
    path::{Component, Path},
};

pub fn read(request: &ReadRequest) -> Result<Vec<u8>, ReadError> {
    let root_path = Path::new(&request.root);
    let path = Path::new(&request.path);
    if !root_path.is_absolute()
        || !path.is_absolute()
        || root_path
            .components()
            .chain(path.components())
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
    {
        return Err(ReadError::ReadFailed);
    }
    let relative = path
        .strip_prefix(root_path)
        .map_err(|_| ReadError::ReadFailed)?;
    if relative.as_os_str().is_empty() {
        return Err(ReadError::ReadFailed);
    }
    let mut root = open_directory(CWD, Path::new("/"))?;
    for part in root_path.components() {
        if let Component::Normal(name) = part {
            root = open_directory(&root, Path::new(name))?;
        }
    }
    verify_path(&root, root_path)?;
    let mut parent = root.try_clone().map_err(|_| ReadError::ReadFailed)?;
    let mut parts = relative.components().peekable();
    let target = loop {
        let Some(Component::Normal(name)) = parts.next() else {
            return Err(ReadError::ReadFailed);
        };
        if parts.peek().is_some() {
            parent = open_directory(&parent, Path::new(name))?;
        } else {
            break File::from(
                openat(
                    &parent,
                    Path::new(name),
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| ReadError::ReadFailed)?,
            );
        }
    };
    let metadata = target.metadata().map_err(|_| ReadError::ReadFailed)?;
    if !metadata.is_file() {
        return Err(ReadError::ReadFailed);
    }
    if metadata.len() > request.max_bytes {
        return Err(ReadError::OutputLimit);
    }
    verify_path(&target, path)?;
    let mut bytes = Vec::new();
    (&target)
        .take(request.max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ReadError::ReadFailed)?;
    if bytes.len() as u64 > request.max_bytes {
        return Err(ReadError::OutputLimit);
    }
    verify_path(&root, root_path)?;
    verify_path(&target, path)?;
    Ok(bytes)
}

fn open_directory(parent: impl std::os::fd::AsFd, path: &Path) -> Result<File, ReadError> {
    openat(
        parent,
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| ReadError::ReadFailed)
}

fn verify_path(file: &File, expected: &Path) -> Result<(), ReadError> {
    let actual = getpath(file).map_err(|_| ReadError::ReadFailed)?;
    if actual.as_bytes() != expected.as_os_str().as_bytes() {
        return Err(ReadError::ReadFailed);
    }
    Ok(())
}
