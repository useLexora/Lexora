use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr,
};

use serde::{Deserialize, Serialize};
use windows_sys::Win32::{
    Foundation::{ERROR_INSUFFICIENT_BUFFER, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Security::{
        Authorization::{
            EXPLICIT_ACCESS_W, GRANT_ACCESS, REVOKE_ACCESS, SetEntriesInAclW, TRUSTEE_IS_SID,
            TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
        },
        CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, GetKernelObjectSecurity,
        GetSecurityDescriptorControl, GetSecurityDescriptorDacl, InitializeSecurityDescriptor,
        OBJECT_INHERIT_ACE, SE_DACL_AUTO_INHERIT_REQ, SE_DACL_AUTO_INHERITED, SE_DACL_PROTECTED,
        SECURITY_DESCRIPTOR, SetKernelObjectSecurity, SetSecurityDescriptorControl,
        SetSecurityDescriptorDacl,
    },
    Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_EXECUTE,
        FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
        FILE_SHARE_WRITE, GetFileInformationByHandle, GetFinalPathNameByHandleW, READ_CONTROL,
        WRITE_DAC,
    },
    System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
};

use super::cancellation::Cancellation;
use super::security::{
    LocalMemory, Profile, SecurityDescriptor, boolean, check, current_process, owned, sid_text,
    wide,
};
use crate::windows_security::{Sid, process_user_sid};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Grant {
    pub(super) path: String,
    pub(super) access: Access,
    pub(super) device: String,
    pub(super) inode: String,
    #[serde(default = "inherited")]
    pub(super) inherit: bool,
    #[serde(default)]
    pub(super) exceptions: Vec<String>,
}

fn inherited() -> bool {
    true
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum Access {
    Read,
    Traverse,
    Write,
    DenyRead,
    DenyWrite,
}

pub(super) struct Grants {
    _handles: Vec<OpenedGrant>,
    pub(super) capabilities: Vec<String>,
}

struct OpenedGrant {
    file: File,
    can_write_dacl: bool,
}

pub(super) fn capability(owner: &str, grant: &Grant) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(format!(
        "v4:{owner}:{}:{}:{}",
        grant.path.to_uppercase(),
        grant.device,
        grant.inode
    ));
    let parts: Vec<_> = hash[..16]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|part| u32::from_le_bytes(*part).to_string())
        .collect();
    format!("S-1-5-21-{}", parts.join("-"))
}

const DIRECTORY_METADATA: u32 = FILE_READ_ATTRIBUTES
    | windows_sys::Win32::Storage::FileSystem::FILE_TRAVERSE
    | windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;

pub(super) fn add_traversal_grants(grants: &mut Vec<Grant>) -> io::Result<()> {
    let mut ancestors = std::collections::BTreeMap::new();
    for denied in grants
        .iter()
        .filter(|grant| matches!(grant.access, Access::DenyRead))
    {
        for exception in &denied.exceptions {
            if !super::policy::contains(&denied.path, exception)
                || super::policy::contains(exception, &denied.path)
                || !grants.iter().any(|grant| {
                    matches!(grant.access, Access::Read | Access::Write)
                        && super::policy::contains(&grant.path, exception)
                        && super::policy::contains(exception, &grant.path)
                })
            {
                return Err(io::ErrorKind::InvalidInput.into());
            }
            for path in Path::new(exception).ancestors().skip(1) {
                let path = path.to_str().ok_or(io::ErrorKind::InvalidInput)?;
                if !super::policy::contains(&denied.path, path) {
                    break;
                }
                if ancestors.contains_key(&path.to_uppercase()) {
                    continue;
                }
                let mut grant = inspect(path, Access::Traverse)?;
                grant.inherit = false;
                if !open_grant(&grant)?.metadata()?.is_dir() {
                    return Err(io::ErrorKind::InvalidInput.into());
                }
                ancestors.insert(path.to_uppercase(), grant);
                if grants.len() + ancestors.len() > 1024 {
                    return Err(io::ErrorKind::InvalidInput.into());
                }
            }
        }
    }
    grants.extend(ancestors.into_values());
    Ok(())
}

pub(super) fn denial_mask(access: Access) -> io::Result<u32> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_APPEND_DATA, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, WRITE_OWNER,
    };
    match access {
        Access::DenyRead => {
            Ok(FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE)
        }
        Access::DenyWrite => Ok(FILE_WRITE_DATA
            | FILE_APPEND_DATA
            | FILE_WRITE_ATTRIBUTES
            | FILE_WRITE_EA
            | DELETE
            | WRITE_DAC
            | WRITE_OWNER),
        _ => Err(io::ErrorKind::InvalidInput.into()),
    }
}

pub(super) fn revoke_owned(
    file: &File,
    sid: &Sid,
    deny_only: bool,
    inherit: bool,
) -> io::Result<()> {
    use windows_sys::Win32::Security::Authorization::{SE_FILE_OBJECT, SetSecurityInfo};
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, DeleteAce, EqualSid, GetAce, INHERITED_ACE,
    };
    use windows_sys::Win32::System::SystemServices::{
        ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE,
    };
    let mut descriptor = read_dacl_descriptor(file)?;
    let mut dacl = ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    // SAFETY: The descriptor owns the ACL throughout inspection and mutation.
    boolean(unsafe {
        GetSecurityDescriptorDacl(
            descriptor.as_mut_ptr().cast(),
            &mut present,
            &mut dacl,
            &mut defaulted,
        )
    })?;
    if present == 0 || dacl.is_null() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    // SAFETY: The live descriptor contains this complete ACL. Reverse traversal preserves remaining indexes.
    for index in (0..unsafe { (*dacl).AceCount }).rev() {
        let mut entry = ptr::null_mut();
        // SAFETY: The index remains within the current ACL after deleting only higher indexes.
        boolean(unsafe { GetAce(dacl, u32::from(index), &mut entry) })?;
        // SAFETY: Every ACE has this header; only simple allow/deny entries are cast below.
        let header = unsafe { &*entry.cast::<ACE_HEADER>() };
        if u32::from(header.AceFlags) & INHERITED_ACE != 0
            || (header.AceType != ACCESS_DENIED_ACE_TYPE as u8
                && (deny_only || header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8))
        {
            continue;
        }
        // SAFETY: Both simple ACE types contain a valid variable-sized SID at SidStart.
        let ace = unsafe { &*entry.cast::<ACCESS_ALLOWED_ACE>() };
        // SAFETY: Both SIDs have live backing storage.
        if unsafe { EqualSid(ptr::from_ref(&ace.SidStart).cast_mut().cast(), sid.as_ptr()) } != 0 {
            // SAFETY: This removes only the matched explicit entry, preserving every other principal and inherited ACE.
            boolean(unsafe { DeleteAce(dacl, u32::from(index)) })?;
        }
    }
    if inherit {
        // SAFETY: Reapplying the current DACL also completes an interrupted inheritance removal without restoring an old snapshot.
        check(unsafe {
            SetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                dacl,
                ptr::null_mut(),
            )
        })
    } else {
        // SAFETY: This descriptor preserves the original controls and updates only the root object.
        boolean(unsafe {
            SetKernelObjectSecurity(
                file.as_raw_handle(),
                DACL_SECURITY_INFORMATION,
                descriptor.as_mut_ptr().cast(),
            )
        })
    }
}

impl Grants {
    pub(super) fn apply(
        user: &Sid,
        group: &Sid,
        grants: &[Grant],
        cancellation: &Cancellation,
        denials: Option<super::acl_state::DenialUpdate<'_>>,
    ) -> io::Result<Self> {
        use windows_sys::Win32::Security::Authorization::DENY_ACCESS;
        cancellation.check()?;
        if grants.is_empty()
            || grants.len() > 1024
            || (denials.is_none()
                && grants
                    .iter()
                    .any(|grant| matches!(grant.access, Access::DenyRead)))
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let directory = journal_directory()?;
        {
            let _lock = AclLock::acquire()?;
            recover(&directory)?;
        }
        let owner = sid_text(&process_user_sid(current_process())?)?;
        let mut handles = Vec::new();
        for grant in grants {
            cancellation.check()?;
            if super::policy::contains(&directory.to_string_lossy(), &grant.path) {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            handles.push(open_grant_handle(grant)?);
        }
        let mut caps = Vec::new();
        for (grant, handle) in grants
            .iter()
            .zip(&handles)
            .filter(|(grant, _)| matches!(grant.access, Access::Write))
        {
            let name = capability(&owner, grant);
            let cap = super::account::parse_sid(&name)?;
            let mask = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
            ensure_acl(grant, &handle.file, group, mask, GRANT_ACCESS, cancellation)?;
            ensure_acl(grant, &handle.file, &cap, mask, GRANT_ACCESS, cancellation)?;
            caps.push((grant, name, cap));
        }
        if let Some(update) = denials {
            let denials: Vec<_> = grants
                .iter()
                .filter(|grant| matches!(grant.access, Access::DenyRead))
                .cloned()
                .collect();
            super::acl_state::update_denials(update, user, &denials, cancellation)?;
        }
        for (grant, handle) in grants.iter().zip(&handles) {
            cancellation.check()?;
            let file = &handle.file;
            match grant.access {
                Access::Read => {
                    if !handle.can_write_dacl {
                        continue;
                    }
                    if let Err(error) = ensure_acl(
                        grant,
                        file,
                        user,
                        FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                        GRANT_ACCESS,
                        cancellation,
                    ) && error.kind() != io::ErrorKind::PermissionDenied
                    {
                        return Err(error);
                    }
                }
                Access::Traverse => {
                    if grant.inherit || !file.metadata()?.is_dir() {
                        return Err(io::ErrorKind::InvalidInput.into());
                    }
                    ensure_acl(
                        grant,
                        file,
                        user,
                        DIRECTORY_METADATA,
                        GRANT_ACCESS,
                        cancellation,
                    )?;
                }
                Access::DenyWrite => {
                    for (root, _, cap) in &caps {
                        if super::policy::contains(&root.path, &grant.path) {
                            ensure_acl(
                                grant,
                                file,
                                cap,
                                denial_mask(grant.access)?,
                                DENY_ACCESS,
                                cancellation,
                            )?;
                        }
                    }
                }
                Access::Write | Access::DenyRead => {}
            }
        }
        Ok(Self {
            _handles: handles,
            capabilities: caps.into_iter().map(|(_, name, _)| name).collect(),
        })
    }
}

pub(super) fn ensure_acl(
    grant: &Grant,
    file: &File,
    sid: &Sid,
    mask: u32,
    mode: i32,
    cancellation: &Cancellation,
) -> io::Result<()> {
    ensure_acl_inner(grant, file, sid, mask, mode, cancellation, false)
}

fn ensure_acl_inner(
    grant: &Grant,
    file: &File,
    sid: &Sid,
    mask: u32,
    mode: i32,
    cancellation: &Cancellation,
    locked: bool,
) -> io::Result<()> {
    use sha2::{Digest, Sha256};
    use windows_sys::Win32::Security::Authorization::{
        DENY_ACCESS, SE_FILE_OBJECT, SetSecurityInfo,
    };
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, DeleteAce, EqualSid, GetAce, INHERIT_ONLY_ACE,
        INHERITED_ACE,
    };
    use windows_sys::Win32::System::SystemServices::{
        ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE,
    };
    let key = Sha256::digest(format!(
        "{}:{}:{}:{}:{mask}:{mode}:{}",
        grant.path,
        grant.device,
        grant.inode,
        sid_text(sid)?,
        grant.inherit
    ));
    let pending = journal_directory()?.join(format!("acl-{key:x}.pending"));
    let interrupted = pending.exists();
    let inheritance = if grant.inherit {
        OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
    } else {
        0
    };
    let replace_denial = mode == DENY_ACCESS && matches!(grant.access, Access::DenyRead);
    // Descendants retain the full denial: FILE_TRAVERSE is FILE_EXECUTE on files.
    let rules = if replace_denial && !grant.exceptions.is_empty() && file.metadata()?.is_dir() {
        let mut rules = vec![(mask & !DIRECTORY_METADATA, 0)];
        if grant.inherit {
            rules.push((mask, inheritance | INHERIT_ONLY_ACE));
        }
        rules
    } else {
        vec![(mask, inheritance)]
    };
    let mut owned_denials = Vec::new();
    let mut descriptor = read_dacl_descriptor(file)?;
    let mut dacl = ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    // SAFETY: The aligned buffer owns the complete self-relative descriptor.
    boolean(unsafe {
        GetSecurityDescriptorDacl(
            descriptor.as_mut_ptr().cast(),
            &mut present,
            &mut dacl,
            &mut defaulted,
        )
    })?;
    if present == 0 || dacl.is_null() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    // SAFETY: GetSecurityDescriptorDacl returned a valid ACL in the live descriptor.
    for index in 0..unsafe { (*dacl).AceCount } {
        let mut entry = ptr::null_mut();
        // SAFETY: The index is bounded by AceCount; output receives a pointer into the live ACL.
        boolean(unsafe { GetAce(dacl, u32::from(index), &mut entry) })?;
        // SAFETY: Every ACL entry starts with an ACE header; these two simple ACE types share the same layout.
        let header = unsafe { &*entry.cast::<ACE_HEADER>() };
        let kind = if mode == DENY_ACCESS {
            ACCESS_DENIED_ACE_TYPE
        } else {
            ACCESS_ALLOWED_ACE_TYPE
        };
        if header.AceType != kind as u8 {
            continue;
        }
        // SAFETY: This is a simple allow/deny ACE, whose mask and SID immediately follow its header.
        let ace = unsafe { &*entry.cast::<ACCESS_ALLOWED_ACE>() };
        if replace_denial {
            if u32::from(header.AceFlags) & INHERITED_ACE == 0
                // SAFETY: Both SIDs have live backing storage and this is a simple DENY ACE.
                && unsafe { EqualSid(ptr::from_ref(&ace.SidStart).cast_mut().cast(), sid.as_ptr()) }
                    != 0
            {
                owned_denials.push((index, ace.Mask, u32::from(header.AceFlags)));
            }
            continue;
        }
        if !interrupted
            && u32::from(ace.Header.AceFlags) & INHERITED_ACE == 0
            && u32::from(ace.Header.AceFlags) & INHERIT_ONLY_ACE == 0
            && (!grant.inherit || u32::from(ace.Header.AceFlags) & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) == inheritance)
            && ace.Mask & mask == mask
            // SAFETY: Only simple allow/deny ACEs reach this comparison; their SidStart is a complete variable-sized SID.
            && unsafe { EqualSid(ptr::from_ref(&ace.SidStart).cast_mut().cast(), sid.as_ptr()) } != 0
        {
            return Ok(());
        }
    }
    if replace_denial
        && !interrupted
        && owned_denials.len() == rules.len()
        && rules.iter().all(|rule| {
            owned_denials
                .iter()
                .any(|(_, mask, flags)| (*mask, *flags) == *rule)
        })
    {
        return Ok(());
    }
    if !locked {
        let _lock = AclLock::for_root(grant, cancellation)?;
        return ensure_acl_inner(grant, file, sid, mask, mode, cancellation, true);
    }
    if !grant.inherit && !replace_denial {
        let result = change_acl(file, sid, mask, mode, false);
        if interrupted && result.is_ok() {
            fs::remove_file(pending)?;
        }
        return result;
    }
    for (index, _, _) in owned_denials.iter().rev() {
        // SAFETY: Only this account's explicit DENY entries are replaced in memory, never removed on disk first.
        boolean(unsafe { DeleteAce(dacl, u32::from(*index)) })?;
    }
    let entries: Vec<_> = rules
        .iter()
        .map(|(mask, inheritance)| EXPLICIT_ACCESS_W {
            grfAccessPermissions: *mask,
            grfAccessMode: mode,
            grfInheritance: *inheritance,
            Trustee: TRUSTEE_W {
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid.as_ptr().cast(),
                ..Default::default()
            },
        })
        .collect();
    let mut updated = ptr::null_mut();
    // SAFETY: SID and ACL remain live; this replaces only the dedicated identity's explicit denies.
    check(unsafe { SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), dacl, &mut updated) })?;
    let _updated = LocalMemory(updated.cast());
    if !grant.inherit {
        let result = set_root_dacl(file, descriptor.as_mut_ptr().cast(), updated);
        if interrupted && result.is_ok() {
            fs::remove_file(pending)?;
        }
        return result;
    }
    if !interrupted {
        File::create_new(&pending)?.sync_all()?;
    }
    // SAFETY: The pinned root is unchanged; Windows propagates inheritance once without retaining a handle per descendant.
    let result = check(unsafe {
        SetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            updated,
            ptr::null_mut(),
        )
    });
    if result.is_ok()
        || (matches!(grant.access, Access::Read)
            && result
                .as_ref()
                .is_err_and(|error| error.kind() == io::ErrorKind::PermissionDenied))
    {
        fs::remove_file(pending)?;
    }
    result
}

pub(super) struct AclLock(OwnedHandle);
impl AclLock {
    fn acquire() -> io::Result<Self> {
        let user = sid_text(&process_user_sid(current_process())?)?;
        Self::for_user(&user)
    }

    pub(super) fn for_user(user: &str) -> io::Result<Self> {
        if !user.starts_with("S-1-")
            || !user[4..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'-')
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        Self::named(user, &format!("Global\\LexoraBuddySandboxAcl-{user}"), None)
    }

    pub(super) fn for_root(grant: &Grant, cancellation: &Cancellation) -> io::Result<Self> {
        use sha2::{Digest, Sha256};
        let user = sid_text(&process_user_sid(current_process())?)?;
        let key = Sha256::digest(format!(
            "{}:{}:{}",
            grant.path.to_uppercase(),
            grant.device,
            grant.inode
        ));
        Self::named(
            &user,
            &format!("Global\\LexoraBuddySandboxRoot-{user}-{key:x}"),
            Some(cancellation),
        )
    }

    pub(super) fn for_denials(cancellation: &Cancellation) -> io::Result<Self> {
        let user = sid_text(&process_user_sid(current_process())?)?;
        Self::named(
            &user,
            &format!("Global\\LexoraBuddySandboxDenials-{user}"),
            Some(cancellation),
        )
    }

    fn named(user: &str, name: &str, cancellation: Option<&Cancellation>) -> io::Result<Self> {
        let descriptor =
            SecurityDescriptor::new(&format!("D:P(A;;GA;;;{user})(A;;GA;;;SY)(A;;GA;;;BA)"))?;
        let attributes = descriptor.attributes(false);
        // SAFETY: The mutex is scoped to the host user, with no AppContainer access or inherited handle.
        let handle = owned(unsafe { CreateMutexW(&attributes, 0, wide(name).as_ptr()) })?;
        loop {
            if let Some(cancellation) = cancellation {
                cancellation.check()?;
            }
            let interval = if cancellation.is_some() { 100 } else { 10_000 };
            // SAFETY: The owned mutex remains live through each bounded wait and matching ReleaseMutex.
            match unsafe { WaitForSingleObject(handle.as_raw_handle(), interval) } {
                WAIT_OBJECT_0 | WAIT_ABANDONED => return Ok(Self(handle)),
                WAIT_TIMEOUT if cancellation.is_some() => continue,
                WAIT_TIMEOUT => return Err(io::ErrorKind::TimedOut.into()),
                _ => return Err(io::Error::last_os_error()),
            }
        }
    }
}

pub(super) fn inspect(path: &str, access: Access) -> io::Result<Grant> {
    let file = open_path(path)?;
    let (device, inode) = identity(&file, path)?;
    Ok(Grant {
        path: path.to_owned(),
        access,
        device,
        inode,
        inherit: true,
        exceptions: Vec::new(),
    })
}

fn open_path_with_access(path: &str, access: u32) -> io::Result<File> {
    if !crate::windows_path::valid(path) || path.starts_with(r"\\") {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    OpenOptions::new()
        .access_mode(access | FILE_READ_ATTRIBUTES)
        .share_mode(
            FILE_SHARE_READ
                | FILE_SHARE_WRITE
                | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_DELETE,
        )
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

pub(super) fn identity(file: &File, path: &str) -> io::Result<(String, String)> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: A live pinned file is queried into the matching fixed-size information structure.
    boolean(unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) })?;
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut name = vec![0u16; 32768];
    // SAFETY: The declared UTF-16 capacity matches the live output buffer.
    let count = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            name.as_mut_ptr(),
            name.len() as u32,
            0,
        )
    } as usize;
    if count == 0 {
        return Err(io::Error::last_os_error());
    }
    if count >= name.len() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let name = String::from_utf16(&name[..count]).map_err(|_| io::ErrorKind::InvalidData)?;
    let canonical = name.strip_prefix(r"\\?\").unwrap_or(&name);
    if !super::policy::contains(canonical, path) || !super::policy::contains(path, canonical) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok((
        information.dwVolumeSerialNumber.to_string(),
        ((u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow))
            .to_string(),
    ))
}

fn open_path(path: &str) -> io::Result<File> {
    open_path_with_access(path, READ_CONTROL | WRITE_DAC)
}

pub(super) fn open_grant(grant: &Grant) -> io::Result<File> {
    Ok(open_grant_handle(grant)?.file)
}

fn open_grant_handle(grant: &Grant) -> io::Result<OpenedGrant> {
    let (file, can_write_dacl) = match open_path(&grant.path) {
        Err(error)
            if matches!(grant.access, Access::Read)
                && error.kind() == io::ErrorKind::PermissionDenied =>
        {
            (open_path_with_access(&grant.path, READ_CONTROL)?, false)
        }
        result => (result?, true),
    };
    let (device, inode) = identity(&file, &grant.path)?;
    if device != grant.device || inode != grant.inode {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(OpenedGrant {
        file,
        can_write_dacl,
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    profile: String,
    grants: Vec<Grant>,
    #[serde(default)]
    roots: Vec<Grant>,
}
pub(super) fn journal_directory() -> io::Result<PathBuf> {
    let directory =
        super::setup::known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_LocalAppData)?
            .join("Lexora Buddy Sandbox")
            .join("leases");
    crate::private_directories::ensure(&[directory.to_string_lossy().into_owned()])
        .map_err(io::Error::other)?;
    Ok(directory)
}

fn recover(directory: &Path) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        let Some(name) = path.file_stem().and_then(|name| name.to_str()) else {
            continue;
        };
        if super::network::valid_profile(name)
            && path
                .extension()
                .is_some_and(|extension| extension == "pending")
        {
            fs::remove_file(&path)?;
            continue;
        }
        if !super::network::valid_profile(name)
            || path.extension().is_none_or(|extension| extension != "json")
        {
            continue;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path);
        let mut file = match file {
            Ok(file) => file,
            Err(error)
                if error.raw_os_error()
                    == Some(windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION as i32) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        (&mut file)
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let record: Record = serde_json::from_slice(&bytes)?;
        if record.profile != name || record.grants.len() > 100_000 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let profile = Profile::from_name(record.profile)?;
        if record.roots.len() > 1024 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        for grant in &record.roots {
            revoke_tree(grant, &profile.sid)?;
        }
        for grant in &record.grants {
            match open_grant(grant) {
                Ok(file) => {
                    change_acl(&file, &profile.sid, 0, REVOKE_ACCESS, false)?;
                }
                Err(error)
                    if [io::ErrorKind::NotFound, io::ErrorKind::InvalidInput]
                        .contains(&error.kind()) => {}
                Err(error) => return Err(error),
            }
        }
        drop(profile);
        drop(file);
        fs::remove_file(path)?;
    }
    Ok(())
}
impl Drop for AclLock {
    fn drop(&mut self) {
        // SAFETY: Only a successful acquisition constructs this guard, on the same thread that drops it.
        unsafe { ReleaseMutex(self.0.as_raw_handle()) };
    }
}

pub(super) fn read_dacl_descriptor(file: &File) -> io::Result<Vec<usize>> {
    let mut needed = 0;
    // SAFETY: A zero-length query reads only the required size from this live file handle.
    let result = boolean(unsafe {
        GetKernelObjectSecurity(
            file.as_raw_handle(),
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            0,
            &mut needed,
        )
    });
    if let Err(error) = result
        && error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
    {
        return Err(error);
    }
    if needed == 0 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut storage = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    // SAFETY: This aligned buffer has at least the declared size; the returned self-relative descriptor owns no pointers.
    boolean(unsafe {
        GetKernelObjectSecurity(
            file.as_raw_handle(),
            DACL_SECURITY_INFORMATION,
            storage.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    })?;
    Ok(storage)
}

pub(super) fn change_acl(
    file: &File,
    sid: &Sid,
    mask: u32,
    mode: i32,
    inherit: bool,
) -> io::Result<()> {
    let mut storage = read_dacl_descriptor(file)?;
    let descriptor = storage.as_mut_ptr().cast();
    let mut dacl = ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    // SAFETY: The self-relative descriptor remains backed by aligned storage throughout this update.
    boolean(unsafe {
        GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
    })?;
    if present == 0 || dacl.is_null() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: mask,
        grfAccessMode: mode,
        grfInheritance: if inherit {
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
        } else {
            0
        },
        Trustee: TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid.as_ptr().cast(),
            ..Default::default()
        },
    };
    let mut updated = ptr::null_mut();
    // SAFETY: Both input ACL and SID have live backing allocations; the API returns a new ACL.
    check(unsafe { SetEntriesInAclW(1, &entry, dacl, &mut updated) })?;
    let _updated = LocalMemory(updated.cast());
    set_root_dacl(file, descriptor, updated)
}

fn set_root_dacl(
    file: &File,
    descriptor: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR,
    updated: *mut windows_sys::Win32::Security::ACL,
) -> io::Result<()> {
    let mut control = 0;
    let mut revision = 0;
    // SAFETY: Callers retain the complete descriptor and updated ACL throughout this synchronous update.
    boolean(unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) })?;
    let mut preserved = control & (SE_DACL_AUTO_INHERITED | SE_DACL_PROTECTED);
    if preserved & SE_DACL_AUTO_INHERITED != 0 {
        preserved |= SE_DACL_AUTO_INHERIT_REQ;
    }
    let mut security = SECURITY_DESCRIPTOR::default();
    // SAFETY: The absolute descriptor and updated ACL remain live for the handle-scoped synchronous update.
    unsafe {
        boolean(InitializeSecurityDescriptor(
            ptr::from_mut(&mut security).cast(),
            1,
        ))?;
        boolean(SetSecurityDescriptorDacl(
            ptr::from_mut(&mut security).cast(),
            1,
            updated,
            0,
        ))?;
        // The low-level setter requires AUTO_INHERIT_REQ to retain AUTO_INHERITED without propagating ACEs.
        boolean(SetSecurityDescriptorControl(
            ptr::from_mut(&mut security).cast(),
            SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ | SE_DACL_PROTECTED,
            preserved,
        ))?;
        boolean(SetKernelObjectSecurity(
            file.as_raw_handle(),
            DACL_SECURITY_INFORMATION,
            ptr::from_mut(&mut security).cast(),
        ))
    }
}

#[cfg(test)]
#[path = "../../__tests__/shell_sandbox_filesystem.rs"]
mod tests;

fn revoke_tree(root: &Grant, sid: &Sid) -> io::Result<()> {
    match open_grant(root) {
        Ok(_) => {}
        Err(error)
            if [io::ErrorKind::NotFound, io::ErrorKind::InvalidInput].contains(&error.kind()) =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    }
    let mut pending = vec![PathBuf::from(&root.path)];
    while let Some(path) = pending.pop() {
        use std::os::windows::fs::MetadataExt;
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            continue;
        }
        let file = open_path(&path.to_string_lossy())?;
        identity(&file, &path.to_string_lossy())?;
        change_acl(&file, sid, 0, REVOKE_ACCESS, false)?;
        if metadata.is_dir() {
            for entry in fs::read_dir(&path)? {
                pending.push(entry?.path());
            }
        }
    }
    Ok(())
}
