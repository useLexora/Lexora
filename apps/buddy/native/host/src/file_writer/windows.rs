use super::{WriteError, WriteRequest, check_content};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_SHARE_READ,
    FILE_SHARE_WRITE, GetFinalPathNameByHandleW, ReplaceFileW,
};

pub fn write(request: &WriteRequest) -> Result<(), WriteError> {
    if !crate::windows_path::valid(&request.root) || !crate::windows_path::valid(&request.path) {
        return Err(WriteError::Failed);
    }
    let path = Path::new(&request.path);
    if !path.starts_with(&request.root) || path == Path::new(&request.root) {
        return Err(WriteError::Failed);
    }
    let parent = path.parent().ok_or(WriteError::Failed)?;
    let mut pinned = Vec::new();
    // Deny directory renames until replacement finishes, including ancestors above the grant.
    for directory in parent.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let handle = OpenOptions::new()
            .access_mode(FILE_LIST_DIRECTORY)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(directory)
            .map_err(|_| WriteError::Failed)?;
        if !handle.metadata().map_err(|_| WriteError::Failed)?.is_dir()
            || final_path(&handle)? != directory.to_string_lossy().trim_end_matches('\\')
        {
            return Err(WriteError::Failed);
        }
        pinned.push(handle);
    }
    let original = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| WriteError::Failed)?;
    if final_path(&original)? != request.path.trim_end_matches('\\') {
        return Err(WriteError::Failed);
    }
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
        if final_path(&current)? != request.path.trim_end_matches('\\') {
            return Err(WriteError::Failed);
        }
        check_content(&current, &request.expected)?;
        drop(current);
        let wide = |path: &Path| {
            path.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>()
        };
        let destination = wide(path);
        let replacement = wide(&temporary);
        let previous = wide(&backup);
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
                let _ = fs::rename(&backup, path);
            }
            return Err(WriteError::Failed);
        }
        let _ = fs::remove_file(&backup);
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    drop(pinned);
    result
}

fn final_path(file: &File) -> Result<String, WriteError> {
    let mut buffer = vec![0u16; 32768];
    // SAFETY: The handle remains owned by file and the buffer covers the passed length.
    let size = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    if size == 0 || size >= buffer.len() {
        return Err(WriteError::Failed);
    }
    let path = String::from_utf16(&buffer[..size]).map_err(|_| WriteError::Failed)?;
    let path = if let Some(path) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{path}")
    } else {
        path.strip_prefix("\\\\?\\")
            .ok_or(WriteError::Failed)?
            .to_owned()
    };
    Ok(path.trim_end_matches('\\').to_owned())
}
