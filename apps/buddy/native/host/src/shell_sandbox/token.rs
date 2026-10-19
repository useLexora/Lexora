use super::{
    account,
    security::{SecurityDescriptor, boolean, owned, sid_text},
};
use crate::windows_security::Sid;
use std::{
    io,
    os::windows::io::{AsRawHandle, OwnedHandle},
    ptr,
};
use windows_sys::Win32::{
    Foundation::HANDLE,
    Security::{
        CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, GetSecurityDescriptorDacl,
        GetTokenInformation, LUA_TOKEN, SID_AND_ATTRIBUTES, SetTokenInformation,
        TOKEN_DEFAULT_DACL, TOKEN_GROUPS, TokenDefaultDacl, TokenGroups, WRITE_RESTRICTED,
    },
    System::SystemServices::SE_GROUP_LOGON_ID,
};

pub(super) fn restrict(
    base: HANDLE,
    capabilities: &[String],
    owner: &Sid,
    user: &Sid,
) -> io::Result<OwnedHandle> {
    if capabilities.is_empty() || capabilities.len() > 1024 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let logon = logon_sid(base)?;
    let everyone = Sid::well_known(windows_sys::Win32::Security::WinWorldSid)?;
    let caps = capabilities
        .iter()
        .map(|text| account::parse_sid(text))
        .collect::<io::Result<Vec<_>>>()?;
    let entries: Vec<SID_AND_ATTRIBUTES> = caps
        .iter()
        .chain([user, &logon, &everyone])
        .map(|sid| SID_AND_ATTRIBUTES {
            Sid: sid.as_ptr(),
            Attributes: 0,
        })
        .collect();
    let mut token = ptr::null_mut();
    // SAFETY: All restrictions have live SID backing; the privileged service token is never used as the base.
    boolean(unsafe {
        CreateRestrictedToken(
            base,
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
            0,
            ptr::null(),
            0,
            ptr::null(),
            entries.len() as u32,
            entries.as_ptr(),
            &mut token,
        )
    })?;
    let token = owned(token)?;
    let security = SecurityDescriptor::new(&format!(
        "D:P(A;;RC;;;OW)(A;;GA;;;SY)(A;;GA;;;{})(A;;GA;;;{})",
        sid_text(&logon)?,
        sid_text(owner)?
    ))?;
    let mut dacl = ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    // SAFETY: The descriptor owns a complete DACL; SetTokenInformation copies it before the backing allocation is released.
    unsafe {
        boolean(GetSecurityDescriptorDacl(
            security.as_ptr(),
            &mut present,
            &mut dacl,
            &mut defaulted,
        ))?;
        let value = TOKEN_DEFAULT_DACL { DefaultDacl: dacl };
        boolean(SetTokenInformation(
            token.as_raw_handle(),
            TokenDefaultDacl,
            ptr::from_ref(&value).cast(),
            size_of_val(&value) as u32,
        ))?;
    }
    Ok(token)
}

fn logon_sid(token: HANDLE) -> io::Result<Sid> {
    let mut needed = 0;
    // SAFETY: The first query obtains only the required length for this live token.
    unsafe { GetTokenInformation(token, TokenGroups, ptr::null_mut(), 0, &mut needed) };
    if needed < size_of::<TOKEN_GROUPS>() as u32 || needed > 1024 * 1024 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut storage = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    // SAFETY: Aligned output has at least the reported capacity.
    boolean(unsafe {
        GetTokenInformation(
            token,
            TokenGroups,
            storage.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    })?;
    // SAFETY: A successful query initialized the struct and trailing groups within the buffer.
    let groups = unsafe { &*storage.as_ptr().cast::<TOKEN_GROUPS>() };
    // SAFETY: GroupCount belongs to the successfully initialized variable-sized token information.
    let groups =
        unsafe { std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize) };
    for group in groups {
        if group.Attributes & SE_GROUP_LOGON_ID as u32 == SE_GROUP_LOGON_ID as u32 {
            // SAFETY: Group SIDs are backed by the live token-information allocation.
            return unsafe { Sid::copy(group.Sid) };
        }
    }
    Err(io::ErrorKind::PermissionDenied.into())
}
