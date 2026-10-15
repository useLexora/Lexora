use super::{WriteError, WriteRequest, check_content};
use crate::windows_fs;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::windows::fs::OpenOptionsExt,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, MoveFileExW, ReplaceFileW,
};

pub fn write(request: &WriteRequest) -> Result<(), WriteError> {
    if !crate::windows_path::valid(&request.root) || !crate::windows_path::valid(&request.path) {
        return Err(WriteError::Failed);
    }
    let path = Path::new(&request.path);
    let parent = path.parent().ok_or(WriteError::Failed)?;
    let _parents = windows_fs::ParentGuard::new(path).map_err(|_| WriteError::Failed)?;
    let _root_parents =
        windows_fs::ParentGuard::new(Path::new(&request.root)).map_err(|_| WriteError::Failed)?;
    let root =
        windows_fs::open_directory(Path::new(&request.root)).map_err(|_| WriteError::Failed)?;
    let root_path = windows_fs::final_path(&root).map_err(|_| WriteError::Failed)?;
    let original = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| WriteError::Failed)?;
    let actual_path = windows_fs::final_path(&original).map_err(|_| WriteError::Failed)?;
    let metadata = original.metadata().map_err(|_| WriteError::Failed)?;
    if !actual_path.starts_with(&root_path)
        || actual_path == root_path
        || windows_fs::is_name_surrogate(&original).map_err(|_| WriteError::Failed)?
        || metadata.permissions().readonly()
        || windows_fs::information(&original)
            .map_err(|_| WriteError::Failed)?
            .nNumberOfLinks
            != 1
    {
        return Err(WriteError::Failed);
    }
    let original_identity = windows_fs::identity(&original).map_err(|_| WriteError::Failed)?;
    check_content(&original, &request.expected)?;
    drop(original);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WriteError::Failed)?
        .as_nanos();
    let temporary = parent.join(format!(".lexora-save-{}-{nonce}", std::process::id()));
    let backup = parent.join(format!(
        ".lexora-save-{}-{nonce}.backup",
        std::process::id()
    ));
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| WriteError::Failed)?;
        output
            .write_all(request.content.as_bytes())
            .map_err(|_| WriteError::Failed)?;
        output.sync_all().map_err(|_| WriteError::Failed)?;
        drop(output);
        let current = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| WriteError::Failed)?;
        if windows_fs::identity(&current).map_err(|_| WriteError::Failed)? != original_identity {
            return Err(WriteError::Conflict);
        }
        check_content(&current, &request.expected)?;
        drop(current);
        let destination =
            windows_fs::extended_path(&actual_path).map_err(|_| WriteError::Failed)?;
        let replacement = windows_fs::extended_path(&temporary).map_err(|_| WriteError::Failed)?;
        let previous = windows_fs::extended_path(&backup).map_err(|_| WriteError::Failed)?;
        // SAFETY: All paths are null-terminated and remain alive for the call.
        let replaced = unsafe {
            ReplaceFileW(
                destination.as_ptr(),
                replacement.as_ptr(),
                previous.as_ptr(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if replaced == 0 {
            if !path.exists() && backup.exists() {
                // SAFETY: Both buffers are terminated; zero flags preserve any newly occupied destination.
                unsafe { MoveFileExW(previous.as_ptr(), destination.as_ptr(), 0) };
            }
            return Err(WriteError::Failed);
        }
        let _ = fs::remove_file(&backup);
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}
