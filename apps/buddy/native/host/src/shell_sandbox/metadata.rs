use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    ptr,
};

use serde::{Deserialize, Serialize};
use windows_sys::Win32::{
    Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, Authorization::REVOKE_ACCESS, GetAce,
        GetSecurityDescriptorDacl,
    },
    Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ, FILE_SHARE_WRITE, READ_CONTROL, WRITE_DAC,
    },
    System::SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE},
};

use super::{
    filesystem::{self, AclLock},
    network::valid_profile,
    security::{boolean, derive_sid},
    setup,
};
use crate::windows_security::Sid;

const RECORD_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Directory {
    path: String,
    device: String,
    inode: String,
}

pub(super) fn capability(profile: &str) -> io::Result<Sid> {
    if !valid_profile(profile) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    super::security::capability(&format!("{profile}.Metadata"))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    profile: String,
    user: String,
    directories: Vec<Directory>,
    #[serde(default)]
    null_device: bool,
}

impl Directory {
    fn open(&self) -> io::Result<File> {
        let file = open(&self.path)?;
        let (device, inode) = filesystem::identity(&file, &self.path)?;
        if device != self.device || inode != self.inode {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        Ok(file)
    }
}

fn open(path: &str) -> io::Result<File> {
    if !crate::windows_path::valid(path) || path.starts_with(r"\\") {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    OpenOptions::new()
        .access_mode(READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

fn open_null() -> io::Result<File> {
    OpenOptions::new()
        .access_mode(READ_CONTROL | WRITE_DAC)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(r"\\.\NUL")
}

fn has_capability(file: &File, sid: &Sid) -> io::Result<bool> {
    let mut descriptor = filesystem::read_dacl_descriptor(file)?;
    let mut dacl = ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    // SAFETY: The aligned descriptor owns the entire ACL and remains live during the bounded ACE scan.
    unsafe {
        boolean(GetSecurityDescriptorDacl(
            descriptor.as_mut_ptr().cast(),
            &mut present,
            &mut dacl,
            &mut defaulted,
        ))?;
        if present == 0 || dacl.is_null() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let mut found = false;
        for index in 0..u32::from((*dacl).AceCount) {
            let mut ace = ptr::null_mut();
            boolean(GetAce(dacl, index, &mut ace))?;
            let header = &*ace.cast::<ACE_HEADER>();
            if ![ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE]
                .contains(&u32::from(header.AceType))
            {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
            if usize::from(header.AceSize) < offset + 8 {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let entry = &*ace.cast::<ACCESS_ALLOWED_ACE>();
            let pointer = ptr::addr_of!(entry.SidStart).cast::<u8>();
            let size = 8 + 4 * usize::from(*pointer.add(1));
            if size > usize::from(header.AceSize) - offset {
                return Err(io::ErrorKind::InvalidData.into());
            }
            if Sid::copy(pointer.cast_mut().cast())? == *sid {
                if found
                    || u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE
                    || header.AceFlags != 0
                    || entry.Mask != FILE_READ_ATTRIBUTES
                {
                    return Err(io::ErrorKind::PermissionDenied.into());
                }
                found = true;
            }
        }
        Ok(found)
    }
}

fn revoke(file: &File, sid: &Sid) -> io::Result<()> {
    if has_capability(file, sid)? {
        filesystem::change_acl(file, sid, 0, REVOKE_ACCESS, false)?;
    }
    Ok(())
}

fn journal_directory() -> io::Result<PathBuf> {
    let executable = setup::installed_path()?;
    let parent = executable.parent().ok_or(io::ErrorKind::InvalidData)?;
    let _parent = setup::protected_object(parent)?;
    let directory = parent.join("metadata-leases");
    match fs::create_dir(&directory) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    setup::protected_object(&directory)?;
    Ok(directory)
}

#[cfg(test)]
fn publish(directory: &Path, record: &Record) -> io::Result<PathBuf> {
    use std::io::Write;
    let bytes = serde_json::to_vec(record)?;
    if bytes.len() > RECORD_LIMIT {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let pending = directory.join(format!("{}.pending", record.profile));
    let path = directory.join(format!("{}.json", record.profile));
    if path.exists() {
        return Err(io::ErrorKind::AlreadyExists.into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending)?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&pending, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&pending);
    }
    result?;
    Ok(path)
}

pub(super) fn recover() -> io::Result<()> {
    let directory = journal_directory()?;
    for entry in fs::read_dir(&directory)? {
        let path = entry?.path();
        let Some(profile) = path
            .file_stem()
            .and_then(|name| name.to_str())
            .filter(|name| valid_profile(name))
        else {
            return Err(io::ErrorKind::InvalidData.into());
        };
        setup::protected_object(&path)?;
        if path
            .extension()
            .is_some_and(|extension| extension == "pending")
        {
            fs::remove_file(path)?;
            continue;
        }
        if path.extension().is_none_or(|extension| extension != "json") {
            return Err(io::ErrorKind::InvalidData.into());
        }
        recover_record(&path, profile)?;
    }
    fs::remove_dir(directory)?;
    Ok(())
}

fn recover_record(path: &Path, profile: &str) -> io::Result<()> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(RECORD_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > RECORD_LIMIT {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let record: Record = serde_json::from_slice(&bytes)?;
    if record.profile != profile || record.directories.len() > 4096 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let _lock = AclLock::for_user(&record.user)?;
    let sid = capability(profile)?;
    if record.null_device {
        filesystem::change_acl(
            &open_null()?,
            &derive_sid(profile)?,
            0,
            REVOKE_ACCESS,
            false,
        )?;
    }
    for node in record.directories {
        revoke(&node.open()?, &sid)?;
    }
    fs::remove_file(path)
}

#[cfg(test)]
#[path = "../../__tests__/shell_sandbox_metadata.rs"]
mod tests;
