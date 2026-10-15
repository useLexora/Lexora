use super::{
    protocol::{Error, Result},
    resources::identity,
};
use cap_std::fs::{Dir, File, OpenOptions, OpenOptionsExt};
use std::{
    mem::{offset_of, size_of},
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    path::Path,
    ptr,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ, FILE_SHARE_WRITE,
};

use windows_sys::{
    Wdk::Storage::FileSystem::{
        FILE_RENAME_INFORMATION, FileRenameInformation, NtSetInformationFile,
    },
    Win32::{Foundation::RtlNtStatusToDosError, System::IO::IO_STATUS_BLOCK},
};

pub struct RenameSource(File);

impl RenameSource {
    pub fn open(from: &Dir, source: &Path, expected: Option<&str>) -> Result<Self> {
        let file = from.open_with(
            source,
            OpenOptions::new()
                .access_mode(DELETE | FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT),
        )?;
        let metadata = file.metadata()?;
        if crate::windows_fs::is_name_surrogate(&file)? {
            return Err(Error::Unsupported);
        }
        if let Some(expected) = expected
            && identity(&metadata)? != expected
        {
            return Err(Error::Conflict);
        }
        Ok(Self(file))
    }

    pub fn rename(&self, to: &Dir, destination: &Path) -> Result<()> {
        let name: Vec<u16> = destination.as_os_str().encode_wide().collect();
        let offset = offset_of!(FILE_RENAME_INFORMATION, FileName);
        let length = (offset + (name.len() + 1) * 2).max(size_of::<FILE_RENAME_INFORMATION>());
        let mut storage = vec![0u64; length.div_ceil(8)];
        let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
        // SAFETY: Aligned, zeroed storage includes the variable name and its terminator; both handles remain live.
        unsafe {
            (*info).RootDirectory = to.as_raw_handle();
            (*info).FileNameLength = (name.len() * 2) as u32;
            ptr::copy_nonoverlapping(
                name.as_ptr(),
                storage.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),
                name.len(),
            );
            let mut status_block = IO_STATUS_BLOCK::default();
            let status = NtSetInformationFile(
                self.0.as_raw_handle(),
                &mut status_block,
                info.cast(),
                length as u32,
                FileRenameInformation,
            );
            if status < 0 {
                let error = std::io::Error::from_raw_os_error(RtlNtStatusToDosError(status) as i32);
                return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
                    Error::Conflict
                } else {
                    error.into()
                });
            }
        }
        Ok(())
    }
}

pub fn rename_new(
    from: &Dir,
    source: &Path,
    to: &Dir,
    destination: &Path,
    expected: Option<&str>,
) -> Result<()> {
    RenameSource::open(from, source, expected)?.rename(to, destination)
}

#[cfg(test)]
#[path = "../../__tests__/file_engine_windows.rs"]
mod tests;
