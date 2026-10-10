use std::{
    fs::{File, OpenOptions},
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    ptr,
};

use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FILE_DIRECTORY_FILE, FILE_OPEN_IF, FILE_OPEN_REPARSE_POINT,
            FILE_SYNCHRONOUS_IO_NONALERT, NtCreateFile,
        },
    },
    Win32::{
        Foundation::{OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, UNICODE_STRING},
        Storage::FileSystem::{
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FileAttributeTagInfo,
            GetFileInformationByHandleEx, READ_CONTROL, SYNCHRONIZE,
        },
        System::{IO::IO_STATUS_BLOCK, WindowsProgramming::FILE_CREATED},
    },
};

use super::{
    DirectoryError, DirectoryFailure, DirectoryOperation, SystemErrorDomain, directory_parts,
};

mod security;
use security::PrivateSecurity;

#[derive(PartialEq, Eq)]
pub(super) enum ExistingDirectoryPolicy {
    Preserve,
    ValidateAcl,
}

pub(super) fn ensure(
    paths: &[String],
    existing: ExistingDirectoryPolicy,
) -> Result<(), DirectoryFailure> {
    let security = PrivateSecurity::new()?;
    for (directory_index, path) in paths.iter().enumerate() {
        let (root, parts) = directory_parts(path).map_err(|code| {
            DirectoryFailure::new(code, DirectoryOperation::Request).at_directory(directory_index)
        })?;
        let root = open_root(&root).map_err(|error| error.at_directory(directory_index))?;
        let mut handles = vec![root];
        for (index, part) in parts.iter().enumerate() {
            let parent = handles.last().ok_or_else(|| {
                DirectoryFailure::new(DirectoryError::Failed, DirectoryOperation::OpenDirectory)
                    .at_directory(directory_index)
            })?;
            let private =
                existing == ExistingDirectoryPolicy::ValidateAcl && index + 1 == parts.len();
            let (child, created) = open_child(parent, part, &security, private)
                .map_err(|error| error.at_directory(directory_index))?;
            if existing == ExistingDirectoryPolicy::ValidateAcl && created && !private {
                let (checked, _) = open_child(parent, part, &security, true)
                    .map_err(|error| error.at_directory(directory_index))?;
                security
                    .validate(&checked)
                    .map_err(|error| error.at_directory(directory_index))?;
            } else if private {
                security
                    .validate(&child)
                    .map_err(|error| error.at_directory(directory_index))?;
            }
            handles.push(child);
        }
    }
    Ok(())
}

fn open_root(path: &str) -> Result<File, DirectoryFailure> {
    let root = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| DirectoryFailure::io(DirectoryOperation::OpenRoot, error))?;
    validate_directory(&root)?;
    Ok(root)
}

fn open_child(
    parent: &File,
    name: &str,
    security: &PrivateSecurity,
    private: bool,
) -> Result<(File, bool), DirectoryFailure> {
    let mut name: Vec<u16> = name.encode_utf16().collect();
    let len = u16::try_from(name.len() * 2).map_err(|_| {
        DirectoryFailure::new(DirectoryError::Invalid, DirectoryOperation::OpenDirectory)
    })?;
    let name = UNICODE_STRING {
        Length: len,
        MaximumLength: len,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &name,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        SecurityDescriptor: security.as_ptr().cast(),
        ..Default::default()
    };
    let mut handle = ptr::null_mut();
    let mut status = IO_STATUS_BLOCK::default();
    // SAFETY: One validated name is resolved relative to the live parent handle. ACL storage and all outputs stay live throughout this synchronous call.
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_READ_ATTRIBUTES
                | FILE_TRAVERSE
                | SYNCHRONIZE
                | if private { READ_CONTROL } else { 0 },
            &attributes,
            &mut status,
            ptr::null(),
            FILE_ATTRIBUTE_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_OPEN_IF,
            FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            ptr::null(),
            0,
        )
    };
    if result < 0 {
        return Err(DirectoryFailure::system(
            DirectoryOperation::OpenDirectory,
            SystemErrorDomain::Ntstatus,
            result as u32,
        ));
    }
    // SAFETY: NtCreateFile succeeded; the newly owned directory handle transfers exactly once.
    let file = unsafe { File::from_raw_handle(handle) };
    validate_directory(&file)?;
    Ok((file, status.Information == FILE_CREATED as usize))
}

fn validate_directory(file: &File) -> Result<(), DirectoryFailure> {
    let mut attributes = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: The directory handle is live and the output has the declared size.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileAttributeTagInfo,
            ptr::from_mut(&mut attributes).cast(),
            size_of_val(&attributes) as u32,
        )
    } == 0
    {
        return Err(DirectoryFailure::io(
            DirectoryOperation::InspectDirectory,
            std::io::Error::last_os_error(),
        ));
    }
    if attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(DirectoryFailure::new(
            DirectoryError::Unsafe,
            DirectoryOperation::InspectDirectory,
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../__tests__/private_directories_windows.rs"]
mod tests;
