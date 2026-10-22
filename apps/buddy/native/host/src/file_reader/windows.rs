use std::{
    fs::{File, OpenOptions},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
};

use crate::windows_fs;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_SEQUENTIAL_SCAN, FILE_SHARE_READ, FILE_TYPE_DISK,
    GetFileType,
};

use super::ReadError;

pub fn with_file<T>(
    root_path: &str,
    path: &str,
    exact_path: bool,
    operation: impl FnOnce(&mut File) -> Result<T, ReadError>,
) -> Result<T, ReadError> {
    if !crate::windows_path::valid(root_path) || !crate::windows_path::valid(path) {
        return Err(ReadError::ReadFailed);
    }
    let _parents =
        windows_fs::ParentGuard::new(Path::new(path)).map_err(|_| ReadError::ReadFailed)?;
    let _root_parents =
        windows_fs::ParentGuard::new(Path::new(root_path)).map_err(|_| ReadError::ReadFailed)?;
    let root =
        windows_fs::open_directory(Path::new(root_path)).map_err(|_| ReadError::ReadFailed)?;
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_SEQUENTIAL_SCAN | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| ReadError::ReadFailed)?;
    // SAFETY: The live File owns this handle throughout the call.
    if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK {
        return Err(ReadError::ReadFailed);
    }
    let final_root = windows_fs::final_path(&root).map_err(|_| ReadError::ReadFailed)?;
    let final_file = windows_fs::final_path(&file).map_err(|_| ReadError::ReadFailed)?;
    if !final_file.starts_with(&final_root) || final_file == final_root {
        return Err(ReadError::ReadFailed);
    }
    let metadata = file.metadata().map_err(|_| ReadError::ReadFailed)?;
    if !metadata.is_file()
        || windows_fs::is_name_surrogate(&file).map_err(|_| ReadError::ReadFailed)?
    {
        return Err(ReadError::ReadFailed);
    }
    if exact_path
        && (!windows_fs::eq_ignore_case(&final_root.to_string_lossy(), root_path)
            || !windows_fs::eq_ignore_case(&final_file.to_string_lossy(), path))
    {
        return Err(ReadError::ReadFailed);
    }
    let result = operation(&mut file)?;
    // Keep the root's delete-denying handle alive until all bytes have been read.
    drop(root);
    Ok(result)
}
