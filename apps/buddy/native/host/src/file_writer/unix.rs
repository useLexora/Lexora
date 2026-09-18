use super::{WriteError, WriteRequest, check_content};
use rustix::fs::{AtFlags, CWD, Mode, OFlags, openat, renameat, unlinkat};
use std::{
    fs::File,
    io::Write,
    os::unix::fs::MetadataExt,
    path::{Component, Path},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn write(request: &WriteRequest) -> Result<(), WriteError> {
    let root_path = Path::new(&request.root);
    let path = Path::new(&request.path);
    if !root_path.is_absolute()
        || !path.is_absolute()
        || root_path
            .components()
            .chain(path.components())
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
    {
        return Err(WriteError::Failed);
    }
    let relative = path
        .strip_prefix(root_path)
        .map_err(|_| WriteError::Failed)?;
    let name = relative.file_name().ok_or(WriteError::Failed)?;
    let mut root = directory(CWD, Path::new("/"))?;
    for part in root_path.components() {
        if let Component::Normal(name) = part {
            root = directory(&root, Path::new(name))?;
        }
    }
    let mut parent = root.try_clone().map_err(|_| WriteError::Failed)?;
    for part in relative.parent().ok_or(WriteError::Failed)?.components() {
        if let Component::Normal(name) = part {
            parent = directory(&parent, Path::new(name))?;
        }
    }
    let original = read_file(&parent, Path::new(name))?;
    check_content(&original, &request.expected)?;
    let metadata = original.metadata().map_err(|_| WriteError::Failed)?;
    if metadata.nlink() != 1 {
        return Err(WriteError::Failed);
    }
    let _writable = openat(
        &parent,
        Path::new(name),
        OFlags::WRONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| WriteError::Failed)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WriteError::Failed)?
        .as_nanos();
    let temporary = format!(".lexora-save-{}-{nonce}", std::process::id());
    let mut output = File::from(
        openat(
            &parent,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|_| WriteError::Failed)?,
    );
    let result = (|| {
        output
            .write_all(request.content.as_bytes())
            .map_err(|_| WriteError::Failed)?;
        copy_metadata(&original, &output)?;
        output.sync_all().map_err(|_| WriteError::Failed)?;
        check_content(&read_file(&parent, Path::new(name))?, &request.expected)?;
        verify(&root, root_path)?;
        verify(&parent, path.parent().ok_or(WriteError::Failed)?)?;
        renameat(&parent, temporary.as_str(), &parent, Path::new(name))
            .map_err(|_| WriteError::Failed)?;
        parent.sync_all().map_err(|_| WriteError::Failed)
    })();
    let _ = unlinkat(&parent, temporary.as_str(), AtFlags::empty());
    result
}

fn copy_metadata(original: &File, output: &File) -> Result<(), WriteError> {
    use rustix::fs::{Gid, Uid, fchown};
    let source = original.metadata().map_err(|_| WriteError::Failed)?;
    let target = output.metadata().map_err(|_| WriteError::Failed)?;
    if source.uid() != target.uid() || source.gid() != target.gid() {
        fchown(
            output,
            Some(Uid::from_raw(source.uid())),
            Some(Gid::from_raw(source.gid())),
        )
        .map_err(|_| WriteError::Failed)?;
    }
    output
        .set_permissions(source.permissions())
        .map_err(|_| WriteError::Failed)?;
    copy_attributes(original, output)
}

#[cfg(target_os = "linux")]
fn copy_attributes(original: &File, output: &File) -> Result<(), WriteError> {
    use rustix::fs::{XattrFlags, fgetxattr, flistxattr, fsetxattr};
    use std::ffi::CStr;
    let mut names = vec![0u8; 65536];
    let size = flistxattr(original, names.as_mut_slice()).map_err(|_| WriteError::Failed)?;
    let mut value = vec![0u8; 65536];
    for name in names[..size].split_inclusive(|byte| *byte == 0) {
        let name = CStr::from_bytes_with_nul(name).map_err(|_| WriteError::Failed)?;
        let size =
            fgetxattr(original, name, value.as_mut_slice()).map_err(|_| WriteError::Failed)?;
        fsetxattr(output, name, &value[..size], XattrFlags::empty())
            .map_err(|_| WriteError::Failed)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_attributes(original: &File, output: &File) -> Result<(), WriteError> {
    use rustix::fs::{CopyfileFlags, copyfile_state_alloc, copyfile_state_free, fcopyfile};
    let state = copyfile_state_alloc().map_err(|_| WriteError::Failed)?;
    // SAFETY: Both descriptors are live; state is allocated here and freed once below.
    let result = unsafe {
        fcopyfile(
            original,
            output,
            state,
            CopyfileFlags::ACL | CopyfileFlags::XATTR,
        )
    };
    // SAFETY: state has not been freed or transferred.
    let freed = unsafe { copyfile_state_free(state) };
    result.and(freed).map_err(|_| WriteError::Failed)
}

fn directory(parent: impl std::os::fd::AsFd, path: &Path) -> Result<File, WriteError> {
    openat(
        parent,
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| WriteError::Failed)
}

fn read_file(parent: &File, name: &Path) -> Result<File, WriteError> {
    openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| WriteError::Failed)
}

fn verify(file: &File, expected: &Path) -> Result<(), WriteError> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let actual = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
            .map_err(|_| WriteError::Failed)?;
        if actual != expected {
            return Err(WriteError::Failed);
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let actual = rustix::fs::getpath(file).map_err(|_| WriteError::Failed)?;
        if actual.as_bytes() != expected.as_os_str().as_bytes() {
            return Err(WriteError::Failed);
        }
    }
    Ok(())
}
