//! Windows 10/11, local NTFS, initialized per-user Recycle Bin only.
//! Move the pinned source by handle; never hand an unlocked source path to Shell deletion.
//! $I v2 layout reference (format facts, not copied implementation):
//! https://github.com/libyal/dtformats/blob/main/documentation/Windows%20Recycle.Bin%20file%20formats.asciidoc
use super::{MutationError, io_error, pin_directory, rename_by_handle};
use crate::windows_security::{Sid, process_user_sid};
use std::{
    ffi::c_void,
    fs::{File, OpenOptions},
    io::Write,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::{Path, PathBuf},
    ptr,
    time::{SystemTime, UNIX_EPOCH},
};
use windows_sys::{
    Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{ConvertSidToStringSidW, GetSecurityInfo, SE_FILE_OBJECT},
            OWNER_SECURITY_INFORMATION,
        },
        Storage::FileSystem::{
            DELETE, FILE_DISPOSITION_INFO, FILE_SHARE_READ, FILE_WRITE_DATA, FileDispositionInfo,
            GetDriveTypeW, GetVolumeInformationW, SetFileInformationByHandle,
        },
        System::{Com::CoCreateGuid, Threading::GetCurrentProcess},
    },
    core::GUID,
};

pub(super) struct Destination {
    record: PathBuf,
    payload: PathBuf,
    _directories: Vec<File>,
}

pub(super) fn prepare(source: &Path) -> Result<Destination, MutationError> {
    let text = source.to_str().ok_or(MutationError::UnsafePath)?;
    if text.len() < 3 || text.as_bytes()[1..3] != *b":\\" {
        return Err(MutationError::Unsupported);
    }
    let volume = &text[..3];
    let wide: Vec<u16> = volume.encode_utf16().chain(Some(0)).collect();
    let mut filesystem = [0u16; 32];
    // SAFETY: NUL-terminated volume. 3 is DRIVE_FIXED.
    if unsafe { GetDriveTypeW(wide.as_ptr()) } != 3 {
        return Err(MutationError::Unsupported);
    }
    // SAFETY: NUL-terminated volume and live, correctly sized filesystem output storage.
    if unsafe {
        GetVolumeInformationW(
            wide.as_ptr(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    } == 0
        || filesystem[..5] != [78, 84, 70, 83, 0]
    {
        return Err(MutationError::Unsupported);
    }
    let bin = Path::new(volume).join("$Recycle.Bin");
    if text
        .to_lowercase()
        .starts_with(&format!("{}\\", bin.display()).to_lowercase())
    {
        return Err(MutationError::UnsafePath);
    }
    // SAFETY: Borrowed pseudo process handle; SID storage owns its bytes.
    let user = process_user_sid(unsafe { GetCurrentProcess() }).map_err(io_error)?;
    let mut sid = ptr::null_mut();
    // SAFETY: Valid owned SID, initialized output, allocation is owned below.
    if unsafe { ConvertSidToStringSidW(user.as_ptr(), &mut sid) } == 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let sid = LocalMemory(sid.cast());
    let mut units = Vec::new();
    for index in 0..256 {
        // SAFETY: ConvertSidToStringSidW guarantees a NUL-terminated SID string.
        let unit = unsafe { *sid.0.cast::<u16>().add(index) };
        if unit == 0 {
            break;
        }
        units.push(unit);
    }
    let sid = String::from_utf16(&units).map_err(|_| MutationError::Unsupported)?;
    let directory = bin.join(sid);
    // Never create/configure a system bin or change its ACL. Unsupported/missing bins fail closed.
    let bin_handle = pin_directory(&bin).map_err(|_| MutationError::Unsupported)?;
    let directory_handle = pin_directory(&directory).map_err(|_| MutationError::Unsupported)?;
    let mut owner = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    // SAFETY: Pinned directory includes READ_CONTROL; owner belongs to returned descriptor storage.
    let status = unsafe {
        GetSecurityInfo(
            directory_handle.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    let _descriptor = LocalMemory(descriptor.cast());
    if status != 0 {
        return Err(MutationError::Unsupported);
    }
    // SAFETY: Successful GetSecurityInfo initialized owner in the live descriptor.
    if unsafe { Sid::copy(owner) }.map_err(io_error)? != user {
        return Err(MutationError::UnsafePath);
    }
    Destination::new(&directory, vec![bin_handle, directory_handle])
}

impl Destination {
    fn new(directory: &Path, handles: Vec<File>) -> Result<Self, MutationError> {
        let mut guid = GUID::default();
        // SAFETY: Initialized, writable GUID output. No COM apartment is required for this API.
        if unsafe { CoCreateGuid(&mut guid) } < 0 {
            return Err(MutationError::Unsupported);
        }
        let id = format!(
            "{:08x}{:04x}{:04x}{:016x}",
            guid.data1,
            guid.data2,
            guid.data3,
            u64::from_be_bytes(guid.data4)
        );
        Ok(Self {
            record: directory.join(format!("$I{id}")),
            payload: directory.join(format!("$R{id}")),
            _directories: handles,
        })
    }

    pub(super) fn commit(&self, original: &str, source: &File) -> Result<(), MutationError> {
        let mut record = Record {
            file: OpenOptions::new()
                .write(true)
                .access_mode(FILE_WRITE_DATA | DELETE)
                .share_mode(FILE_SHARE_READ)
                .create_new(true)
                .open(&self.record)
                .map_err(io_error)?,
            keep: false,
        };
        let path: Vec<u16> = original.encode_utf16().chain(Some(0)).collect();
        let ticks = u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| MutationError::Failed)?
                .as_nanos()
                / 100,
        )
        .ok()
        .and_then(|ticks| ticks.checked_add(116_444_736_000_000_000))
        .ok_or(MutationError::Failed)?;
        let mut metadata = Vec::with_capacity(28 + path.len() * 2);
        metadata.extend_from_slice(&2u64.to_le_bytes());
        metadata.extend_from_slice(&source.metadata().map_err(io_error)?.len().to_le_bytes());
        metadata.extend_from_slice(&ticks.to_le_bytes());
        metadata.extend_from_slice(&(path.len() as u32).to_le_bytes());
        for unit in path {
            metadata.extend_from_slice(&unit.to_le_bytes());
        }
        record.file.write_all(&metadata).map_err(io_error)?;
        record.file.sync_all().map_err(io_error)?;
        // Metadata is durable before moving data. The original handle NEVER leaves this caller.
        // Pinned bin ancestors and OS no-replace rename cover both source identity and destination.
        // On a kill after the move, the complete $I/$R pair remains recoverable by Windows Shell.
        rename_by_handle(source, &self.payload)?;
        record.keep = true;
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn fixture(directory: &Path) -> Result<Self, MutationError> {
        Self::new(directory, vec![pin_directory(directory)?])
    }
    #[cfg(test)]
    pub(super) fn paths(&self) -> (&Path, &Path) {
        (&self.record, &self.payload)
    }
}

// Cleanup is limited to the exclusively created metadata record, by its own handle.
// This can never delete the source/payload or a path substituted by another process.
struct Record {
    file: File,
    keep: bool,
}
impl Drop for Record {
    fn drop(&mut self) {
        if !self.keep {
            let info = FILE_DISPOSITION_INFO { DeleteFile: true };
            // SAFETY: Owned DELETE-enabled metadata handle and correctly sized live structure.
            unsafe {
                SetFileInformationByHandle(
                    self.file.as_raw_handle(),
                    FileDispositionInfo,
                    ptr::from_ref(&info).cast(),
                    std::mem::size_of_val(&info) as u32,
                );
            }
        }
    }
}
struct LocalMemory(*mut c_void);
impl Drop for LocalMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: Only allocations returned by LocalAlloc-backed Win32 APIs are stored here.
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}
