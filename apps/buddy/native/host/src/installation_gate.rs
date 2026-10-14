use std::io;

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_FILE_NOT_FOUND, GetLastError, WAIT_ABANDONED, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    },
    System::Threading::{
        MUTEX_MODIFY_STATE, OpenMutexW, ReleaseMutex, SYNCHRONIZATION_SYNCHRONIZE,
        WaitForSingleObject,
    },
};

pub const MUTEX_NAME: &str = "Local\\lexora-buddy-installation";

pub fn installation_active() -> io::Result<bool> {
    let name: Vec<u16> = MUTEX_NAME.encode_utf16().chain([0]).collect();
    // SAFETY: The NUL-terminated name is live; the returned handle belongs to this call.
    let handle = unsafe {
        OpenMutexW(
            SYNCHRONIZATION_SYNCHRONIZE | MUTEX_MODIFY_STATE,
            0,
            name.as_ptr(),
        )
    };
    if handle.is_null() {
        // SAFETY: Read immediately after OpenMutexW failed.
        return if unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND {
            Ok(false)
        } else {
            Err(io::Error::last_os_error())
        };
    }
    // SAFETY: The handle has synchronization rights. This never waits for an installer.
    let result = unsafe { WaitForSingleObject(handle, 0) };
    let active = match result {
        WAIT_TIMEOUT => Ok(true),
        WAIT_OBJECT_0 | WAIT_ABANDONED => {
            // SAFETY: A successful wait grants mutex ownership to this thread.
            unsafe { ReleaseMutex(handle) };
            Ok(false)
        }
        _ => Err(io::Error::last_os_error()),
    };
    // SAFETY: This call owns the handle and no further operations use it.
    unsafe { CloseHandle(handle) };
    active
}
