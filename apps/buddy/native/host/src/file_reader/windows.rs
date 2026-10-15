use std::{
    fs::OpenOptions,
    io::Read,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
};

use crate::windows_fs;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_SEQUENTIAL_SCAN, FILE_SHARE_READ, FILE_TYPE_DISK,
    GetFileType,
};

use super::{ReadError, ReadRequest};

pub fn read(request: &ReadRequest) -> Result<Vec<u8>, ReadError> {
    if !crate::windows_path::valid(&request.root) || !crate::windows_path::valid(&request.path) {
        return Err(ReadError::ReadFailed);
    }
    let _parents = windows_fs::ParentGuard::new(Path::new(&request.path))
        .map_err(|_| ReadError::ReadFailed)?;
    let _root_parents = windows_fs::ParentGuard::new(Path::new(&request.root))
        .map_err(|_| ReadError::ReadFailed)?;
    let root =
        windows_fs::open_directory(Path::new(&request.root)).map_err(|_| ReadError::ReadFailed)?;
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_SEQUENTIAL_SCAN | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&request.path)
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
    if metadata.len() > request.max_bytes {
        return Err(ReadError::OutputLimit);
    }
    let mut bytes = Vec::new();
    file.take(request.max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ReadError::ReadFailed)?;
    if bytes.len() as u64 > request.max_bytes {
        return Err(ReadError::OutputLimit);
    }
    // Keep the root's delete-denying handle alive until all bytes have been read.
    drop(root);
    Ok(bytes)
}
