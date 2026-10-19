#[cfg(windows)]
fn main() -> std::io::Result<()> {
    let argument = std::env::args()
        .nth(1)
        .ok_or(std::io::ErrorKind::InvalidInput)?;
    if argument == "--watch-process" {
        watch_process()
    } else if argument == "--volume-metadata" {
        let directory = std::env::args().nth(2).unwrap_or_else(|| r"C:\".into());
        probe_directory_access(&directory);
        Ok(())
    } else if argument == "--rewrite-dacl-write" {
        rewrite_dacl_write()
    } else {
        probe_token(&argument)
    }
}

#[cfg(windows)]
fn rewrite_dacl_write() -> std::io::Result<()> {
    use std::{io, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            DACL_SECURITY_INFORMATION, SetFileSecurityW,
        },
    };
    let path = std::env::args().nth(2).ok_or(io::ErrorKind::InvalidInput)?;
    let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
    let sddl: Vec<u16> = "D:(A;;FA;;;WD)".encode_utf16().chain([0]).collect();
    let mut descriptor = ptr::null_mut();
    // SAFETY: Both strings are terminated; this test mutates only its synthetic fixture.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: The descriptor is live and valid for the synchronous file-security update.
    let rewrite =
        if unsafe { SetFileSecurityW(wide.as_ptr(), DACL_SECURITY_INFORMATION, descriptor) } == 0 {
            io::Error::last_os_error().raw_os_error().unwrap_or(-1)
        } else {
            0
        };
    // SAFETY: The conversion allocated this descriptor with LocalAlloc.
    unsafe { LocalFree(descriptor) };
    let write = std::fs::write(path, "ESCAPED")
        .err()
        .map_or(0, |error| error.raw_os_error().unwrap_or(-1));
    println!(
        "{}",
        serde_json::json!({"rewriteDacl": rewrite, "write": write})
    );
    Ok(())
}

#[cfg(windows)]
fn probe_directory_access(directory: &str) {
    use std::{os::windows::io::FromRawHandle, os::windows::io::OwnedHandle, ptr};
    use windows_sys::Win32::{Foundation::INVALID_HANDLE_VALUE, Storage::FileSystem::*};

    let root: Vec<u16> = directory.encode_utf16().chain([0]).collect();
    let mut results = serde_json::Map::new();
    // SAFETY: Queries attributes of a fixture-supplied directory without enumerating its contents.
    let query = if unsafe { GetFileAttributesW(root.as_ptr()) } == INVALID_FILE_ATTRIBUTES {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(-1)
    } else {
        0
    };
    results.insert("queryAttributes".into(), query.into());
    for (name, mask) in [
        ("readAttributes", FILE_READ_ATTRIBUTES),
        ("listDirectory", FILE_LIST_DIRECTORY),
        ("addFile", FILE_ADD_FILE),
        ("addDirectory", FILE_ADD_SUBDIRECTORY),
        ("deleteChild", FILE_DELETE_CHILD),
        ("writeAttributes", FILE_WRITE_ATTRIBUTES),
        ("writeExtendedAttributes", FILE_WRITE_EA),
        ("writeDacl", WRITE_DAC),
        ("writeOwner", WRITE_OWNER),
        ("delete", DELETE),
    ] {
        // SAFETY: OPEN_EXISTING does not enumerate or mutate the fixture-supplied directory.
        let handle = unsafe {
            CreateFileW(
                root.as_ptr(),
                mask,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                ptr::null_mut(),
            )
        };
        let code = if handle == INVALID_HANDLE_VALUE || handle.is_null() {
            std::io::Error::last_os_error().raw_os_error().unwrap_or(-1)
        } else {
            // SAFETY: The newly created handle transfers ownership exactly once.
            drop(unsafe { OwnedHandle::from_raw_handle(handle) });
            0
        };
        results.insert(name.into(), code.into());
    }
    println!("{}", serde_json::Value::Object(results));
}

#[cfg(windows)]
fn probe_token(path: &str) -> std::io::Result<()> {
    use std::{
        io,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr,
    };
    use windows_sys::Win32::{
        Security::*,
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    let mut handle = ptr::null_mut();
    // SAFETY: This negative test requests only its own token; the runner grants no host token handles.
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE,
            &mut handle,
        )
    } == 0
    {
        println!("token-denied");
        return Ok(());
    }
    // SAFETY: Ownership of the successfully returned token handle transfers once.
    let token = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut storage = [0usize; 128];
    let mut needed = 0;
    // SAFETY: Aligned TOKEN_USER output has room for the largest valid SID.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            storage.as_mut_ptr().cast(),
            size_of_val(&storage) as u32,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: The successful query initialized the TOKEN_USER header in live backing storage.
    let user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    let restriction = SID_AND_ATTRIBUTES {
        Sid: user.User.Sid,
        Attributes: 0,
    };
    let mut handle = ptr::null_mut();
    // SAFETY: Attempts to discard the command-specific denial SID while preserving its inherited user restriction.
    if unsafe {
        CreateRestrictedToken(
            token.as_raw_handle(),
            0,
            0,
            ptr::null(),
            0,
            ptr::null(),
            1,
            &restriction,
            &mut handle,
        )
    } == 0
    {
        println!("restriction-denied");
        return Ok(());
    }
    // SAFETY: Ownership of the newly restricted token handle transfers once.
    let restricted = unsafe { OwnedHandle::from_raw_handle(handle) };
    // SAFETY: The test impersonates only its own derived token, targeting a synthetic fixture.
    if unsafe { ImpersonateLoggedOnUser(restricted.as_raw_handle()) } == 0 {
        println!("impersonation-denied");
        return Ok(());
    }
    let result = std::fs::read_to_string(path);
    // SAFETY: Reverts only the impersonation started on this thread immediately above.
    unsafe { RevertToSelf() };
    println!(
        "{}",
        if result.is_ok() {
            "ESCAPED"
        } else {
            "file-denied"
        }
    );
    Ok(())
}

#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
fn watch_process() -> std::io::Result<()> {
    use std::{
        io,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        time::Duration,
    };
    use windows_sys::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::*};
    let pid = std::env::args()
        .nth(2)
        .ok_or(io::ErrorKind::InvalidInput)?
        .parse::<u32>()
        .map_err(|_| io::ErrorKind::InvalidInput)?;
    // SAFETY: The fixture observes only a caller-owned process; no mutation rights are requested.
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: The successful OpenProcess returned one owned handle.
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut peak = 0;
    let mut samples = 0;
    loop {
        let mut count = 0;
        // SAFETY: The process handle is live and the count output is writable.
        if unsafe { GetProcessHandleCount(handle.as_raw_handle(), &mut count) } != 0 {
            peak = peak.max(count);
            samples += 1;
        }
        // SAFETY: A bounded wait observes process exit without changing its state.
        if unsafe { WaitForSingleObject(handle.as_raw_handle(), 10) } == WAIT_OBJECT_0 {
            break;
        }
        if samples > Duration::from_secs(120).as_millis() / 10 {
            return Err(io::ErrorKind::TimedOut.into());
        }
    }
    println!(
        "{}",
        serde_json::json!({"peakHandles": peak, "samples": samples})
    );
    Ok(())
}
