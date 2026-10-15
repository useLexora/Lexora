use std::{
    fs::{File, OpenOptions},
    io,
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::{Path, PathBuf},
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
    FILE_SHARE_WRITE, FileAttributeTagInfo, GetFileInformationByHandle,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW,
};

pub struct ParentGuard(Vec<File>);

impl ParentGuard {
    pub fn new(path: &Path) -> io::Result<Self> {
        let parent = path
            .parent()
            .or_else(|| path.has_root().then_some(path))
            .ok_or(io::ErrorKind::InvalidInput)?;
        let mut handles = Vec::new();
        for directory in parent.ancestors().collect::<Vec<_>>().into_iter().rev() {
            match open_directory(directory) {
                Ok(file) => handles.push(file),
                Err(error) if error.kind() == io::ErrorKind::NotFound => break,
                Err(error) => return Err(error),
            }
        }
        Ok(Self(handles))
    }
}

impl Drop for ParentGuard {
    fn drop(&mut self) {
        while self.0.pop().is_some() {}
    }
}

pub fn open_directory(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_dir() || is_name_surrogate(&file)? {
        return Err(io::ErrorKind::Unsupported.into());
    }
    Ok(file)
}

pub fn is_name_surrogate(file: &impl AsRawHandle) -> io::Result<bool> {
    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: The live handle and initialized structure match FileAttributeTagInfo and its size.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileAttributeTagInfo,
            (&raw mut info).cast(),
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(info.ReparseTag & 0x20000000 != 0)
}

pub fn eq_ignore_case(left: &str, right: &str) -> bool {
    use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    // SAFETY: Both slices are live and their explicit lengths fit i32 for validated file paths.
    unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        ) == CSTR_EQUAL
    }
}

pub fn information(file: &File) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: The live file owns the handle and the output structure is initialized and writable.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(information)
}

pub fn identity(file: &File) -> io::Result<(u32, u32, u32)> {
    let info = information(file)?;
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

pub fn final_path(file: &File) -> io::Result<PathBuf> {
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
    if size == 0 {
        return Err(io::Error::last_os_error());
    }
    if size >= buffer.len() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let path = String::from_utf16(&buffer[..size]).map_err(|_| io::ErrorKind::InvalidData)?;
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        Ok(PathBuf::from(format!(r"\\{unc}")))
    } else {
        Ok(PathBuf::from(
            path.strip_prefix(r"\\?\")
                .ok_or(io::ErrorKind::InvalidData)?,
        ))
    }
}

pub fn extended_path(path: &Path) -> io::Result<Vec<u16>> {
    let value = path
        .to_str()
        .filter(|path| crate::windows_path::valid(path))
        .ok_or(io::ErrorKind::InvalidInput)?;
    let path = if let Some(unc) = value.strip_prefix(r"\\") {
        PathBuf::from(format!(r"\\?\UNC\{unc}"))
    } else {
        PathBuf::from(format!(r"\\?\{value}"))
    };
    Ok(path.as_os_str().encode_wide().chain(Some(0)).collect())
}
