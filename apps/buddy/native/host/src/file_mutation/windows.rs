use super::{EntryKind, MutationError, MutationRequest, Operation};
use std::{
    fs::{self, File, OpenOptions},
    mem::{offset_of, size_of, size_of_val},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
    FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FileAttributeTagInfo, FileRenameInfo, GetFileInformationByHandleEx, GetFinalPathNameByHandleW,
    SetFileInformationByHandle,
};

mod recycle;

pub(super) struct PreparedMutation {
    request: MutationRequest,
    destination: Option<PathBuf>,
    source: Option<File>,
    kind: EntryKind,
    recycle: Option<recycle::Destination>,
    _ancestors: Vec<File>,
}

pub(super) fn prepare(request: MutationRequest) -> Result<PreparedMutation, MutationError> {
    if !crate::windows_path::valid(&request.root) || !crate::windows_path::valid(&request.path) {
        return Err(MutationError::UnsafePath);
    }
    let root = Path::new(&request.root);
    let path = Path::new(&request.path);
    if !path.starts_with(root) {
        return Err(MutationError::UnsafePath);
    }
    let create = matches!(
        request.operation,
        Operation::CreateFile | Operation::CreateDirectory
    );
    if !create && path == root {
        return Err(MutationError::UnsafePath);
    }
    let parent = if create {
        path
    } else {
        path.parent().ok_or(MutationError::UnsafePath)?
    };
    let mut ancestors = Vec::new();
    // Deny ancestor renames/deletion and reject *all* reparse points, including above the grant.
    for directory in parent.ancestors().collect::<Vec<_>>().into_iter().rev() {
        ancestors.push(pin_directory(directory)?);
    }
    let destination = if request.operation != Operation::Trash {
        let name = request.name.as_deref().ok_or(MutationError::InvalidName)?;
        if name.is_empty()
            || name == "."
            || name == ".."
            || name.contains(['/', '\\'])
            || name.encode_utf16().count() > 255
            || name.chars().any(|c| c < ' ' || c == '\u{7f}')
        {
            return Err(MutationError::InvalidName);
        }
        let destination = parent.join(name);
        if !crate::windows_path::valid(destination.to_str().ok_or(MutationError::InvalidName)?) {
            return Err(MutationError::InvalidName);
        }
        if request.operation == Operation::Rename {
            let old_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or(MutationError::UnsafePath)?;
            if old_name != name && old_name.to_lowercase() == name.to_lowercase() {
                return Err(MutationError::CaseOnly);
            }
        }
        Some(destination)
    } else {
        if request.name.is_some() {
            return Err(MutationError::InvalidName);
        }
        None
    };
    let source = if create {
        None
    } else {
        let handle = OpenOptions::new()
            .access_mode(DELETE | FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(io_error)?;
        if !same_path(&final_path(&handle)?, request.path.trim_end_matches('\\')) {
            return Err(MutationError::UnsafePath);
        }
        inspect(&handle)?;
        Some(handle)
    };
    let kind = match request.operation {
        Operation::CreateFile => EntryKind::File,
        Operation::CreateDirectory => EntryKind::Directory,
        _ => inspect(source.as_ref().ok_or(MutationError::Failed)?)?,
    };
    let recycle = if request.operation == Operation::Trash {
        Some(recycle::prepare(path)?)
    } else {
        None
    };
    Ok(PreparedMutation {
        request,
        destination,
        source,
        kind,
        recycle,
        _ancestors: ancestors,
    })
}

impl PreparedMutation {
    pub(super) fn commit(self) -> Result<EntryKind, MutationError> {
        match self.request.operation {
            Operation::CreateFile => {
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(self.destination.as_ref().ok_or(MutationError::Failed)?)
                    .map_err(io_error)?;
            }
            Operation::CreateDirectory => {
                fs::create_dir(self.destination.as_ref().ok_or(MutationError::Failed)?)
                    .map_err(io_error)?;
            }
            Operation::Rename => {
                let destination = self.destination.as_ref().ok_or(MutationError::Failed)?;
                if destination != Path::new(&self.request.path) {
                    rename_by_handle(
                        self.source.as_ref().ok_or(MutationError::Failed)?,
                        destination,
                    )?;
                }
            }
            Operation::Trash => {
                self.recycle
                    .as_ref()
                    .ok_or(MutationError::Unsupported)?
                    .commit(
                        &self.request.path,
                        self.source.as_ref().ok_or(MutationError::Failed)?,
                    )?;
            }
        }
        Ok(self.kind)
    }
}

fn pin_directory(directory: &Path) -> Result<File, MutationError> {
    let handle = OpenOptions::new()
        // Metadata-only opens do not pin the directory namespace on NTFS.
        // Match the existing bounded writer: LIST_DIRECTORY makes delete sharing effective.
        .access_mode(
            FILE_LIST_DIRECTORY
                | FILE_READ_ATTRIBUTES
                | windows_sys::Win32::Storage::FileSystem::READ_CONTROL,
        )
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(directory)
        .map_err(io_error)?;
    if !matches!(inspect(&handle)?, EntryKind::Directory)
        || !same_path(
            &final_path(&handle)?,
            directory.to_string_lossy().trim_end_matches('\\'),
        )
    {
        return Err(MutationError::UnsafePath);
    }
    Ok(handle)
}

fn inspect(file: &File) -> Result<EntryKind, MutationError> {
    let mut attributes = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: The owned handle and correctly sized output buffer remain live throughout the call.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileAttributeTagInfo,
            ptr::from_mut(&mut attributes).cast(),
            size_of_val(&attributes) as u32,
        )
    } == 0
    {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    if attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(MutationError::UnsafePath);
    }
    Ok(
        if attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            EntryKind::Directory
        } else {
            EntryKind::File
        },
    )
}

// Windows resolves paths case-insensitively while NTFS keeps the casing a directory was created
// with: the Recycle Bin root is `$Recycle.Bin` on most volumes but `$RECYCLE.BIN` on others, and
// both names address the same directory. Compare the opened handle against the requested path
// without ASCII case. This cannot accept a substituted entry: the handle is always opened from the
// compared request string, `create`/`rename`/`trash` reject reparse points while pinning, and
// lexical containment (`starts_with`) stays case-sensitive. Non-ASCII case differences keep
// failing closed.
fn same_path(actual: &str, expected: &str) -> bool {
    actual.eq_ignore_ascii_case(expected)
}

fn final_path(file: &File) -> Result<String, MutationError> {
    let mut buffer = vec![0u16; 32768];
    // SAFETY: File owns the handle and the output buffer covers the advertised capacity.
    let size = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    if size == 0 || size >= buffer.len() {
        return Err(MutationError::UnsafePath);
    }
    let path = String::from_utf16(&buffer[..size]).map_err(|_| MutationError::UnsafePath)?;
    let path = if let Some(path) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{path}")
    } else {
        path.strip_prefix("\\\\?\\")
            .ok_or(MutationError::UnsafePath)?
            .to_owned()
    };
    Ok(path.trim_end_matches('\\').to_owned())
}

fn rename_by_handle(source: &File, destination: &Path) -> Result<(), MutationError> {
    let name: Vec<u16> = destination
        .to_str()
        .ok_or(MutationError::UnsafePath)?
        .encode_utf16()
        .collect();
    let offset = offset_of!(FILE_RENAME_INFO, FileName);
    // SetFileInformationByHandle also expects FileName to be NUL-terminated.
    // FileNameLength excludes that terminator; alignment padding is not a substitute:
    // an exactly filled allocation otherwise lets the Win32 path conversion read past it.
    let length = (offset + (name.len() + 1) * size_of::<u16>()).max(size_of::<FILE_RENAME_INFO>());
    // u64 storage gives the flexible structure its required pointer alignment on both architectures.
    let mut storage = vec![0u64; length.div_ceil(8)];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: Aligned storage covers the header, UTF-16 filename and trailing NUL. It starts zeroed:
    // ReplaceIfExists is false, so the OS atomically refuses an existing destination.
    unsafe {
        (*info).FileNameLength = (name.len() * 2) as u32;
        ptr::copy_nonoverlapping(
            name.as_ptr(),
            storage.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),
            name.len(),
        );
        if SetFileInformationByHandle(
            source.as_raw_handle(),
            FileRenameInfo,
            info.cast(),
            length as u32,
        ) == 0
        {
            return Err(io_error(std::io::Error::last_os_error()));
        }
    }
    Ok(())
}

fn io_error(error: std::io::Error) -> MutationError {
    match error.raw_os_error() {
        Some(2 | 3) => MutationError::Missing,
        Some(5) => MutationError::Permission,
        Some(32 | 33) => MutationError::Busy,
        Some(80 | 183) => MutationError::Exists,
        _ => MutationError::Failed,
    }
}

#[cfg(test)]
#[path = "../../__tests__/file_mutation_windows.rs"]
mod tests;
