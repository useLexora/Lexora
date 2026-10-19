use std::{
    fs::{self, File, OpenOptions},
    io,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::PathBuf,
    ptr,
    time::{Duration, Instant},
};

use windows_sys::Win32::{
    Foundation::{
        ERROR_ALREADY_EXISTS, ERROR_SERVICE_ALREADY_RUNNING, ERROR_SERVICE_DOES_NOT_EXIST,
        WAIT_OBJECT_0,
    },
    Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER,
        Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
        DACL_SECURITY_INFORMATION, GetAce, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner,
        IsValidAcl, OWNER_SECURITY_INFORMATION, WinBuiltinAdministratorsSid, WinLocalSystemSid,
    },
    Storage::FileSystem::{
        CreateDirectoryW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, MOVEFILE_DELAY_UNTIL_REBOOT, MOVEFILE_REPLACE_EXISTING,
        MOVEFILE_WRITE_THROUGH, MoveFileExW, READ_CONTROL,
    },
    System::{
        Com::CoTaskMemFree,
        Registry::*,
        Services::*,
        SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE},
        Threading::{GetExitCodeProcess, WaitForSingleObject},
    },
    UI::{
        Shell::{
            FOLDERID_ProgramFiles, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
            SHGetKnownFolderPath, ShellExecuteExW,
        },
        WindowsAndMessaging::SW_HIDE,
    },
};

use super::{
    SERVICE_NAME,
    network::Network,
    security::{
        LocalMemory, SecurityDescriptor, boolean, check, current_process, owned, require_host,
        unique_id, wide,
    },
};
use crate::windows_security::Sid;

const UNINSTALL_KEY: &str =
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LexoraBuddySandbox";
const BINARY: &str = "lexora-buddy-sandbox.exe";

pub(super) struct Service(pub(super) SC_HANDLE);
impl Drop for Service {
    fn drop(&mut self) {
        // SAFETY: The wrapper owns one SCM/service handle, never a kernel HANDLE.
        unsafe { CloseServiceHandle(self.0) };
    }
}

pub(super) fn open_service(access: u32) -> io::Result<Service> {
    // SAFETY: Null names select the local SCM with connect-only access.
    let manager =
        service_handle(unsafe { OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_CONNECT) })?;
    // SAFETY: The manager is live and the fixed service name is NUL-terminated.
    service_handle(unsafe { OpenServiceW(manager.0, wide(SERVICE_NAME).as_ptr(), access) })
}

fn service_handle(handle: SC_HANDLE) -> io::Result<Service> {
    if handle.is_null() {
        Err(io::Error::last_os_error())
    } else {
        Ok(Service(handle))
    }
}

pub(super) fn installed_path() -> io::Result<PathBuf> {
    Ok(known_folder(&FOLDERID_ProgramFiles)?
        .join("Lexora Buddy Sandbox")
        .join(BINARY))
}

pub(super) fn known_folder(id: &windows_sys::core::GUID) -> io::Result<PathBuf> {
    let mut path = ptr::null_mut();
    // SAFETY: The known-folder API resolves Program Files independently of caller-controlled environment variables.
    check(unsafe { SHGetKnownFolderPath(id, 0, ptr::null_mut(), &mut path) } as u32)?;
    let mut units = Vec::new();
    for index in 0..32768 {
        // SAFETY: The API returned a NUL-terminated string with a live COM allocation.
        let unit = unsafe { *path.add(index) };
        if unit == 0 {
            break;
        }
        units.push(unit);
    }
    // SAFETY: SHGetKnownFolderPath requires the matching COM allocator release.
    unsafe { CoTaskMemFree(path.cast()) };
    let path = String::from_utf16(&units).map_err(|_| io::ErrorKind::InvalidData)?;
    Ok(PathBuf::from(path))
}

pub(super) fn elevate(action: &str) -> io::Result<i32> {
    if super::security::token_flag(
        current_process(),
        windows_sys::Win32::Security::TokenIsAppContainer,
    )? {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let executable = wide(&std::env::current_exe()?.to_string_lossy());
    let verb = wide("runas");
    let arguments = wide(action);
    let mut request = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: verb.as_ptr(),
        lpFile: executable.as_ptr(),
        lpParameters: arguments.as_ptr(),
        nShow: SW_HIDE,
        ..Default::default()
    };
    // SAFETY: All launch strings are fixed or the current executable; the OS owns the visible UAC consent flow.
    boolean(unsafe { ShellExecuteExW(&mut request) })?;
    let child = owned(request.hProcess)?;
    // SAFETY: The elevated child handle is live; setup cannot hang the caller indefinitely.
    if unsafe { WaitForSingleObject(child.as_raw_handle(), 180_000) } != WAIT_OBJECT_0 {
        return Err(io::ErrorKind::TimedOut.into());
    }
    let mut code = 0;
    // SAFETY: The process finished and the exit-code output is writable.
    boolean(unsafe { GetExitCodeProcess(child.as_raw_handle(), &mut code) })?;
    Ok(code as i32)
}

pub(super) fn install() -> io::Result<i32> {
    require_host(current_process(), true)?;
    let target = installed_path()?;
    let directory = target.parent().ok_or(io::ErrorKind::InvalidData)?;
    let security =
        SecurityDescriptor::new("O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)")?;
    let attributes = security.attributes(false);
    // SAFETY: Program Files is OS-resolved; the directory is created atomically with a protected administrator-owned DACL.
    if unsafe { CreateDirectoryW(wide(&directory.to_string_lossy()).as_ptr(), &attributes) } == 0
        && io::Error::last_os_error().raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32)
    {
        return Err(io::Error::last_os_error());
    }
    let _directory = protected_object(directory)?;
    if let Ok(service) = open_service(SERVICE_QUERY_STATUS | SERVICE_STOP) {
        stop_idle(&service)?;
    }
    super::metadata::recover()?;
    super::acl_state::discard_unpublished()?;
    super::account::repair()?;
    let source = std::env::current_exe()?;
    if target.exists() {
        protected_object(&target)?;
    }
    if fs::canonicalize(&source)? != fs::canonicalize(&target).unwrap_or_default() {
        let temporary = directory.join(format!("{}.installing", unique_id()?));
        let result = (|| {
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            io::copy(&mut File::open(&source)?, &mut output)?;
            output.sync_all()?;
            drop(output);
            protected_object(&temporary)?;
            // SAFETY: Both paths are pinned under the protected directory; replacement never preserves an old file's weaker ACL.
            boolean(unsafe {
                MoveFileExW(
                    wide(&temporary.to_string_lossy()).as_ptr(),
                    wide(&target.to_string_lossy()).as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
    }
    // SAFETY: Administrative setup opens the local SCM only to create this fixed service.
    let manager = service_handle(unsafe {
        OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_CREATE_SERVICE)
    })?;
    let command = wide(&format!("\"{}\" service", target.display()));
    let name = wide(SERVICE_NAME);
    let display = wide("Lexora Buddy Sandbox");
    let dependencies = wide("BFE\0");
    // SAFETY: All service configuration is fixed; neither model input nor a user-provided program path reaches SCM.
    let handle = unsafe {
        CreateServiceW(
            manager.0,
            name.as_ptr(),
            display.as_ptr(),
            SERVICE_ALL_ACCESS,
            SERVICE_WIN32_OWN_PROCESS,
            SERVICE_DEMAND_START,
            SERVICE_ERROR_NORMAL,
            command.as_ptr(),
            ptr::null(),
            ptr::null_mut(),
            dependencies.as_ptr(),
            ptr::null(),
            ptr::null(),
        )
    };
    let service = if handle.is_null() {
        if io::Error::last_os_error().raw_os_error()
            != Some(windows_sys::Win32::Foundation::ERROR_SERVICE_EXISTS as i32)
        {
            return Err(io::Error::last_os_error());
        }
        let service = open_service(SERVICE_ALL_ACCESS)?;
        // SAFETY: Upgrade/repair replaces only this service's fixed executable/configuration, never its caller's command.
        boolean(unsafe {
            ChangeServiceConfigW(
                service.0,
                SERVICE_WIN32_OWN_PROCESS,
                SERVICE_DEMAND_START,
                SERVICE_ERROR_NORMAL,
                command.as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                dependencies.as_ptr(),
                wide("LocalSystem").as_ptr(),
                ptr::null(),
                display.as_ptr(),
            )
        })?;
        service
    } else {
        Service(handle)
    };
    let service_security = SecurityDescriptor::new("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;CCLCRP;;;AU)")?;
    // SAFETY: Users may query/start the service, but cannot stop it, reconfigure it, or change its security.
    boolean(unsafe {
        SetServiceObjectSecurity(
            service.0,
            DACL_SECURITY_INFORMATION,
            service_security.as_ptr(),
        )
    })?;
    let network = Network::open()?;
    network.install()?;
    network.recover()?;
    super::security::at("network_configuration", network.verify())?;
    register_uninstaller(&target)?;
    Ok(0)
}

pub(super) fn start_service() -> io::Result<()> {
    let service = open_service(SERVICE_START | SERVICE_QUERY_STATUS)?;
    // SAFETY: Starts only the fixed on-demand service; no caller-controlled service arguments are passed.
    if unsafe { StartServiceW(service.0, 0, ptr::null()) } == 0
        && io::Error::last_os_error().raw_os_error() != Some(ERROR_SERVICE_ALREADY_RUNNING as i32)
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn service_pid() -> io::Result<u32> {
    let service = open_service(SERVICE_QUERY_STATUS)?;
    let mut status = SERVICE_STATUS_PROCESS::default();
    let mut size = 0;
    // SAFETY: SCM supplies the actual running service identity; no client-provided PID is trusted.
    boolean(unsafe {
        QueryServiceStatusEx(
            service.0,
            SC_STATUS_PROCESS_INFO,
            ptr::from_mut(&mut status).cast(),
            size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut size,
        )
    })?;
    if status.dwCurrentState != SERVICE_RUNNING || status.dwProcessId == 0 {
        return Err(io::ErrorKind::NotConnected.into());
    }
    Ok(status.dwProcessId)
}

fn stop_idle(service: &Service) -> io::Result<()> {
    let mut status = SERVICE_STATUS::default();
    // SAFETY: This service handle permits query; status is initialized writable storage.
    boolean(unsafe { QueryServiceStatus(service.0, &mut status) })?;
    if status.dwCurrentState == SERVICE_STOPPED {
        return Ok(());
    }
    if status.dwControlsAccepted & SERVICE_ACCEPT_STOP == 0 {
        return Err(io::ErrorKind::ResourceBusy.into());
    }
    // SAFETY: The service advertises STOP only while no active sandbox lease exists.
    boolean(unsafe { ControlService(service.0, SERVICE_CONTROL_STOP, &mut status) })?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        // SAFETY: The service handle remains live throughout this bounded status wait.
        boolean(unsafe { QueryServiceStatus(service.0, &mut status) })?;
        if status.dwCurrentState == SERVICE_STOPPED {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(io::ErrorKind::TimedOut.into())
}

pub(super) fn uninstall() -> io::Result<i32> {
    require_host(current_process(), true)?;
    let service = open_service(
        SERVICE_QUERY_STATUS | SERVICE_STOP | windows_sys::Win32::Storage::FileSystem::DELETE,
    )?;
    stop_idle(&service)?;
    super::metadata::recover()?;
    super::acl_state::discard_unpublished()?;
    super::acl_state::cleanup(None)?;
    super::account::uninstall()?;
    Network::open()?.uninstall()?;
    // SAFETY: Only the fixed product service is removed, after its active leases have ended.
    boolean(unsafe { DeleteService(service.0) })?;
    // SAFETY: The fixed uninstall key belongs solely to this component, not Buddy user data.
    check(unsafe { RegDeleteTreeW(HKEY_LOCAL_MACHINE, wide(UNINSTALL_KEY).as_ptr()) } as u32)?;
    let target = installed_path()?;
    let directory = target.parent().ok_or(io::ErrorKind::InvalidData)?;
    let protected = protected_object(directory)?;
    protected_object(&target)?;
    let tombstone = directory.join(format!("{}.removed", unique_id()?));
    fs::rename(&target, &tombstone)?;
    if fs::remove_file(&tombstone).is_err() {
        // SAFETY: Only this unique retired image is deferred, never the canonical name of a future installation.
        boolean(unsafe {
            MoveFileExW(
                wide(&tombstone.to_string_lossy()).as_ptr(),
                ptr::null(),
                MOVEFILE_DELAY_UNTIL_REBOOT,
            )
        })?;
    }
    drop(protected);
    let _ = fs::remove_dir(directory);
    Ok(0)
}

pub(super) fn status() -> io::Result<i32> {
    let path = installed_path()?;
    let service = open_service(SERVICE_QUERY_STATUS);
    let registered = match service {
        Ok(_) => true,
        Err(error) if error.raw_os_error() == Some(ERROR_SERVICE_DOES_NOT_EXIST as i32) => false,
        Err(error) => return Err(error),
    };
    let installed = registered || path.exists();
    let healthy = registered && configuration_valid(&path).is_ok();
    println!(
        "{}",
        serde_json::json!({"protocol":super::PROTOCOL_VERSION,"installed":installed,"healthy":healthy,"path":path})
    );
    Ok(0)
}

pub(super) fn configuration_valid(path: &std::path::Path) -> io::Result<()> {
    protected_object(path.parent().ok_or(io::ErrorKind::InvalidData)?)?;
    protected_object(path)?;
    let service = open_service(SERVICE_QUERY_CONFIG)?;
    let mut size = 0;
    // SAFETY: The sizing call writes only the required allocation length.
    unsafe { QueryServiceConfigW(service.0, ptr::null_mut(), 0, &mut size) };
    if size < size_of::<QUERY_SERVICE_CONFIGW>() as u32 || size > 65536 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut storage = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
    let config = storage.as_mut_ptr().cast::<QUERY_SERVICE_CONFIGW>();
    // SAFETY: Pointer-aligned storage has the SCM-reported capacity and is live throughout inspection.
    boolean(unsafe { QueryServiceConfigW(service.0, config, size, &mut size) })?;
    // SAFETY: The successful query initialized the configuration struct.
    let config = unsafe { &*config };
    let text = |pointer: *const u16| -> io::Result<String> {
        let start = storage.as_ptr() as usize;
        let end = start + storage.len() * size_of::<usize>();
        let address = pointer as usize;
        if address < start || address >= end || !address.is_multiple_of(2) {
            return Err(io::ErrorKind::InvalidData.into());
        }
        // SAFETY: Pointer and full slice length are checked against the live configuration allocation.
        let units = unsafe { std::slice::from_raw_parts(pointer, (end - address) / 2) };
        let end = units
            .iter()
            .position(|unit| *unit == 0)
            .ok_or(io::ErrorKind::InvalidData)?;
        String::from_utf16(&units[..end]).map_err(|_| io::ErrorKind::InvalidData.into())
    };
    if config.dwServiceType != SERVICE_WIN32_OWN_PROCESS
        || config.dwStartType != SERVICE_DEMAND_START
        || !text(config.lpBinaryPathName)?
            .eq_ignore_ascii_case(&format!("\"{}\" service", path.display()))
        || !text(config.lpServiceStartName)?.eq_ignore_ascii_case("LocalSystem")
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

pub(super) fn protected_object(path: &std::path::Path) -> io::Result<File> {
    use std::os::windows::fs::MetadataExt;
    if fs::symlink_metadata(path)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let file = OpenOptions::new()
        .access_mode(READ_CONTROL)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let mut descriptor = ptr::null_mut();
    // SAFETY: The handle pins this directory; security information is returned as an owned descriptor.
    check(unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    })?;
    let descriptor = LocalMemory(descriptor);
    let trusted = [
        Sid::well_known(WinBuiltinAdministratorsSid)?,
        Sid::well_known(WinLocalSystemSid)?,
    ];
    let mut owner = ptr::null_mut();
    let mut defaulted = 0;
    let mut present = 0;
    let mut dacl = ptr::null_mut();
    // SAFETY: The descriptor is live and all outputs are writable.
    unsafe {
        boolean(GetSecurityDescriptorOwner(
            descriptor.0,
            &mut owner,
            &mut defaulted,
        ))?;
        boolean(GetSecurityDescriptorDacl(
            descriptor.0,
            &mut present,
            &mut dacl,
            &mut defaulted,
        ))?;
        if owner.is_null()
            || !trusted.contains(&Sid::copy(owner)?)
            || present == 0
            || dacl.is_null()
            || IsValidAcl(dacl) == 0
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        for index in 0..u32::from((*dacl).AceCount) {
            let mut ace = ptr::null_mut();
            boolean(GetAce(dacl, index, &mut ace))?;
            let header = &*ace.cast::<ACE_HEADER>();
            match u32::from(header.AceType) {
                ACCESS_ALLOWED_ACE_TYPE => {
                    let offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
                    if usize::from(header.AceSize) < offset + 8 {
                        return Err(io::ErrorKind::InvalidData.into());
                    }
                    let sid =
                        ptr::addr_of!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart).cast::<u8>();
                    let sid_size = 8 + 4 * usize::from(*sid.add(1));
                    if sid_size > usize::from(header.AceSize) - offset {
                        return Err(io::ErrorKind::InvalidData.into());
                    }
                    let entry = &*ace.cast::<ACCESS_ALLOWED_ACE>();
                    let sid = Sid::copy(sid.cast_mut().cast())?;
                    if !trusted.contains(&sid)
                        && entry.Mask & !(FILE_GENERIC_READ | FILE_GENERIC_EXECUTE) != 0
                    {
                        return Err(io::ErrorKind::PermissionDenied.into());
                    }
                }
                ACCESS_DENIED_ACE_TYPE => {}
                _ => return Err(io::ErrorKind::PermissionDenied.into()),
            }
        }
    }
    Ok(file)
}

fn register_uninstaller(target: &std::path::Path) -> io::Result<()> {
    let mut key = ptr::null_mut();
    // SAFETY: Setup writes only the fixed component's HKLM uninstall registration.
    check(unsafe {
        RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            wide(UNINSTALL_KEY).as_ptr(),
            0,
            ptr::null(),
            0,
            KEY_SET_VALUE,
            ptr::null(),
            &mut key,
            ptr::null_mut(),
        )
    } as u32)?;
    let result = (|| {
        for (name, value) in [
            ("DisplayName", "Lexora Buddy Sandbox".to_owned()),
            ("DisplayVersion", env!("CARGO_PKG_VERSION").to_owned()),
            ("Publisher", "Lexora".to_owned()),
            (
                "UninstallString",
                format!("\"{}\" remove", target.display()),
            ),
        ] {
            let value = wide(&value);
            // SAFETY: Each value is NUL-terminated UTF-16 and the byte length includes its terminator.
            check(unsafe {
                RegSetValueExW(
                    key,
                    wide(name).as_ptr(),
                    0,
                    REG_SZ,
                    value.as_ptr().cast(),
                    (value.len() * 2) as u32,
                )
            } as u32)?;
        }
        Ok(())
    })();
    // SAFETY: This closes the one registry handle created above on success or failure.
    unsafe { RegCloseKey(key) };
    result
}
