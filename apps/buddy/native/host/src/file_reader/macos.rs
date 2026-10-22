use super::ReadError;
use rustix::fs::{CWD, Mode, OFlags, getpath, openat};
use std::{
    fs::File,
    os::unix::ffi::OsStrExt,
    path::{Component, Path},
};

pub fn with_file<T>(
    root: &str,
    path: &str,
    _exact_path: bool,
    operation: impl FnOnce(&mut File) -> Result<T, ReadError>,
) -> Result<T, ReadError> {
    let root_path = Path::new(root);
    let path = Path::new(path);
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
    let mut target = loop {
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
    verify_path(&target, path)?;
    let result = operation(&mut target)?;
    verify_path(&root, root_path)?;
    verify_path(&target, path)?;
    Ok(result)
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
