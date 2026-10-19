use std::{
    ffi::c_void,
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::PathBuf,
    ptr,
};

use windows_sys::{
    Win32::{
        Foundation::{HANDLE, INVALID_HANDLE_VALUE, LocalFree},
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SDDL_REVISION_1,
            },
            DeriveCapabilitySidsFromName, FreeSid, GetTokenInformation,
            Isolation::{DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName},
            PSID, SECURITY_ATTRIBUTES, TOKEN_INFORMATION_CLASS, TOKEN_QUERY, TokenElevation,
            TokenIsAppContainer,
        },
        System::{
            Rpc::UuidCreate,
            Threading::{GetCurrentProcess, OpenProcessToken, QueryFullProcessImageNameW},
        },
    },
    core::GUID,
};

use crate::windows_security::Sid;

pub(super) fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

pub(super) fn check(code: u32) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code as i32))
    }
}

pub(super) fn at<T>(phase: &'static str, result: io::Result<T>) -> io::Result<T> {
    result.inspect_err(|error| {
        eprintln!(
            "{}",
            serde_json::json!({
                "type":"diagnostic", "phase":phase, "nativeCode":error.raw_os_error()
            })
        )
    })
}

pub(super) fn boolean(value: i32) -> io::Result<()> {
    if value != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub(super) fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: Callers transfer a newly created, owned Win32 handle exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

pub(super) struct LocalMemory(pub(super) *mut c_void);

impl Drop for LocalMemory {
    fn drop(&mut self) {
        // SAFETY: This allocation came from a LocalAlloc-backed security API.
        unsafe { LocalFree(self.0) };
    }
}

pub(super) struct SecurityDescriptor(LocalMemory);

impl SecurityDescriptor {
    pub(super) fn new(sddl: &str) -> io::Result<Self> {
        let mut descriptor = ptr::null_mut();
        // SAFETY: The NUL-terminated input and writable output remain live for the call.
        boolean(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(sddl).as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        })?;
        Ok(Self(LocalMemory(descriptor)))
    }

    pub(super) fn as_ptr(&self) -> *mut c_void {
        self.0.0
    }

    pub(super) fn attributes(&self, inherit: bool) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.as_ptr(),
            bInheritHandle: i32::from(inherit),
        }
    }
}

pub(super) fn token_flag(process: HANDLE, class: TOKEN_INFORMATION_CLASS) -> io::Result<bool> {
    let mut token = ptr::null_mut();
    // SAFETY: The caller supplies a live process; the token handle output is writable.
    boolean(unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) })?;
    let token = owned(token)?;
    let mut value = 0u32;
    let mut needed = 0;
    // SAFETY: These queried token classes both have one DWORD of output.
    boolean(unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            class,
            ptr::from_mut(&mut value).cast(),
            4,
            &mut needed,
        )
    })?;
    if needed != 4 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(value != 0)
}

pub(super) fn require_host(process: HANDLE, elevated: bool) -> io::Result<()> {
    if token_flag(process, windows_sys::Win32::Security::TokenIsRestricted)?
        || token_flag(process, TokenIsAppContainer)?
        || token_flag(process, TokenElevation)? != elevated
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

pub(super) fn current_process() -> HANDLE {
    // SAFETY: The process pseudo handle is borrowed, never closed.
    unsafe { GetCurrentProcess() }
}

pub(super) fn process_image(process: HANDLE) -> io::Result<PathBuf> {
    let mut path = vec![0u16; 32768];
    let mut size = path.len() as u32;
    // SAFETY: The process is queryable and the UTF-16 output has its declared capacity.
    boolean(unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut size) })?;
    String::from_utf16(&path[..size as usize])
        .map(PathBuf::from)
        .map_err(|_| io::ErrorKind::InvalidData.into())
}

pub(super) fn unique_id() -> io::Result<String> {
    let mut id = GUID::default();
    // SAFETY: id is writable UUID storage; no namespace or external identifier is reused.
    check(unsafe { UuidCreate(&mut id) } as u32)?;
    Ok(format!(
        "{:08x}{:04x}{:04x}{}",
        id.data1,
        id.data2,
        id.data3,
        id.data4
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

pub(super) fn sid_text(sid: &Sid) -> io::Result<String> {
    let mut text = ptr::null_mut();
    // SAFETY: sid owns valid aligned storage; the API allocates a NUL-terminated SID string.
    boolean(unsafe { ConvertSidToStringSidW(sid.as_ptr(), &mut text) })?;
    let allocation = LocalMemory(text.cast());
    let mut units = Vec::new();
    for index in 0..256 {
        // SAFETY: A SID string is NUL-terminated and the allocation is live until after the scan.
        let unit = unsafe { *allocation.0.cast::<u16>().add(index) };
        if unit == 0 {
            return String::from_utf16(&units).map_err(|_| io::ErrorKind::InvalidData.into());
        }
        units.push(unit);
    }
    Err(io::ErrorKind::InvalidData.into())
}

pub(super) fn derive_sid(name: &str) -> io::Result<Sid> {
    let mut sid = ptr::null_mut();
    check(
        // SAFETY: The input is NUL-terminated; the output receives a newly allocated SID.
        unsafe { DeriveAppContainerSidFromAppContainerName(wide(name).as_ptr(), &mut sid) } as u32,
    )?;
    // SAFETY: The preceding API initialized the SID allocation.
    let result = unsafe { Sid::copy(sid) };
    // SAFETY: This is the one matching release for the API-owned SID.
    unsafe { FreeSid(sid) };
    result
}

pub(super) fn capability(name: &str) -> io::Result<Sid> {
    let mut groups = SidArray::default();
    let mut capabilities = SidArray::default();
    // SAFETY: Both zero-initialized arrays receive API-owned allocations, released individually by SidArray.
    boolean(unsafe {
        DeriveCapabilitySidsFromName(
            wide(name).as_ptr(),
            &mut groups.pointer,
            &mut groups.count,
            &mut capabilities.pointer,
            &mut capabilities.count,
        )
    })?;
    if capabilities.count != 1 || capabilities.pointer.is_null() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    // SAFETY: The successful API returned exactly one live SID pointer.
    unsafe { Sid::copy(*capabilities.pointer) }
}

#[derive(Default)]
struct SidArray {
    pointer: *mut PSID,
    count: u32,
}

impl Drop for SidArray {
    fn drop(&mut self) {
        if self.pointer.is_null() {
            return;
        }
        for index in 0..self.count as usize {
            // SAFETY: Each element was independently allocated by DeriveCapabilitySidsFromName.
            unsafe { LocalFree(*self.pointer.add(index)) };
        }
        // SAFETY: The array allocation has a separate matching LocalFree.
        unsafe { LocalFree(self.pointer.cast()) };
    }
}

pub(super) struct Profile {
    pub(super) name: String,
    pub(super) sid: Sid,
}

impl Profile {
    #[cfg(test)]
    pub(super) fn create() -> io::Result<Self> {
        let id = unique_id()?;
        let name = format!("{}{}", super::PROFILE_PREFIX, id);
        Self::from_name(name)
    }

    pub(super) fn from_name(name: String) -> io::Result<Self> {
        if !super::network::valid_profile(&name) {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(Self {
            sid: derive_sid(&name)?,
            name,
        })
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        // SAFETY: Only this command's never-reused profile is deleted, after its processes and grants.
        unsafe { DeleteAppContainerProfile(wide(&self.name).as_ptr()) };
    }
}
