use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, OwnedHandle},
    },
    ptr,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicPtr, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use windows_sys::Win32::{
    Foundation::{ERROR_NO_DATA, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, WAIT_OBJECT_0},
    Security::{DACL_SECURITY_INFORMATION, SetKernelObjectSecurity},
    Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_GENERIC_READ, FILE_WRITE_DATA, PIPE_ACCESS_DUPLEX,
    },
    System::{
        Pipes::*,
        Services::*,
        Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            WaitForSingleObject,
        },
    },
};

use super::{
    PIPE_NAME, PROTOCOL_VERSION, SERVICE_NAME, metadata,
    network::Network,
    process::{Child, LaunchRequest},
    security::{
        SecurityDescriptor, at, boolean, current_process, owned, process_image, require_host, wide,
    },
    setup,
};

static STATUS: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(ptr::null_mut());
static STOP: AtomicBool = AtomicBool::new(false);
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static CONTROL: Mutex<()> = Mutex::new(());
const REQUEST_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Health {
        protocol: u32,
    },
    Account {
        protocol: u32,
        grants: Vec<super::filesystem::Grant>,
    },
    Launch {
        protocol: u32,
        command: LaunchRequest,
    },
}

pub(super) fn dispatch() -> io::Result<i32> {
    let mut name = wide(SERVICE_NAME);
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: name.as_mut_ptr(),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW::default(),
    ];
    // SAFETY: The terminated service table stays live for the dispatcher's entire blocking lifetime.
    boolean(unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) })?;
    Ok(0)
}

unsafe extern "system" fn service_main(_count: u32, _arguments: *mut *mut u16) {
    // SAFETY: SCM invokes this entrypoint; the fixed name and callback remain valid for process lifetime.
    let status = unsafe {
        RegisterServiceCtrlHandlerExW(wide(SERVICE_NAME).as_ptr(), Some(control), ptr::null())
    };
    if status.is_null() {
        return;
    }
    STATUS.store(status, Ordering::Release);
    publish(SERVICE_START_PENDING, 0);
    let code = match serve() {
        Ok(()) => 0,
        Err(_) => 1,
    };
    publish(SERVICE_STOPPED, code);
}

unsafe extern "system" fn control(
    code: u32,
    _event: u32,
    _data: *mut std::ffi::c_void,
    _context: *mut std::ffi::c_void,
) -> u32 {
    let Ok(_guard) = CONTROL.lock() else { return 1 };
    if code == SERVICE_CONTROL_STOP && ACTIVE.load(Ordering::Acquire) == 0 {
        STOP.store(true, Ordering::Release);
        publish(SERVICE_STOP_PENDING, 0);
    }
    0
}

fn publish(state: u32, error: u32) {
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == SERVICE_RUNNING && ACTIVE.load(Ordering::Acquire) == 0 {
            SERVICE_ACCEPT_STOP
        } else {
            0
        },
        dwWin32ExitCode: error,
        dwWaitHint: if state == SERVICE_START_PENDING {
            10000
        } else {
            0
        },
        ..Default::default()
    };
    // SAFETY: Only the SCM-issued status handle is published to this atomic and remains valid until service exit.
    unsafe { SetServiceStatus(STATUS.load(Ordering::Acquire), &status) };
}

enum State {
    Preparing,
    Pending { bytes: Vec<u8>, deadline: Instant },
    Active { child: Child, job: OwnedHandle },
}
struct Client {
    pipe: File,
    owner: OwnedHandle,
    state: State,
}

fn serve() -> io::Result<()> {
    let observation = SecurityDescriptor::new("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x101000;;;AU)")?;
    // SAFETY: Clients may observe this dedicated service's identity/exit, but cannot read memory, obtain its token or mutate it.
    boolean(unsafe {
        SetKernelObjectSecurity(
            current_process(),
            DACL_SECURITY_INFORMATION,
            observation.as_ptr(),
        )
    })?;
    let network = Network::open()?;
    network.verify()?;
    metadata::recover()?;
    let mut listener = listener(true)?;
    let mut clients: Vec<Client> = Vec::new();
    let mut idle_since = Instant::now();
    publish(SERVICE_RUNNING, 0);
    while !STOP.load(Ordering::Acquire) {
        let guard = CONTROL.lock().map_err(|_| io::ErrorKind::Other)?;
        if !STOP.load(Ordering::Acquire) && connected(&listener)? {
            let pipe = std::mem::replace(&mut listener, self::listener(false)?);
            if clients.len() < 32
                && let Ok(owner) = authenticate_client(&pipe)
            {
                clients.push(Client {
                    pipe,
                    owner,
                    state: State::Pending {
                        bytes: Vec::new(),
                        deadline: Instant::now() + Duration::from_secs(5),
                    },
                });
                ACTIVE.store(clients.len(), Ordering::Release);
                publish(SERVICE_RUNNING, 0);
            }
        }
        drop(guard);
        let mut index = 0;
        while index < clients.len() {
            let alive = match handle_client(&mut clients[index], &network) {
                Ok(alive) => alive,
                Err(error) => {
                    let phase = error
                        .get_ref()
                        .and_then(|error| error.downcast_ref::<super::process::LaunchError>());
                    let code = phase
                        .map_or_else(|| error.raw_os_error(), |phase| phase.source.raw_os_error())
                        .unwrap_or(31);
                    let reply = format!(
                        "{}\n",
                        serde_json::json!({ "error": code, "phase": phase.map(|error| error.phase) })
                    );
                    let _ = clients[index].pipe.write_all(reply.as_bytes());
                    false
                }
            };
            if alive {
                index += 1;
            } else {
                let mut client = clients.swap_remove(index);
                let leased = matches!(client.state, State::Preparing | State::Active { .. });
                if let State::Active { child, job } = client.state {
                    drop(child);
                    drop(job);
                }
                if leased {
                    let _ = client.pipe.write_all(b"done\n");
                }
            }
        }
        if ACTIVE.swap(clients.len(), Ordering::AcqRel) != clients.len() {
            publish(SERVICE_RUNNING, 0);
        }
        if clients.is_empty() {
            if idle_since.elapsed() >= Duration::from_secs(30) {
                break;
            }
        } else {
            idle_since = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

fn listener(first: bool) -> io::Result<File> {
    let descriptor = SecurityDescriptor::new("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x0012019b;;;AU)")?;
    let attributes = descriptor.attributes(false);
    // SAFETY: The fixed local-only endpoint forbids sandbox identities and remote clients; only SYSTEM creates server instances.
    let handle = owned(unsafe {
        CreateNamedPipeW(
            wide(PIPE_NAME).as_ptr(),
            PIPE_ACCESS_DUPLEX
                | if first {
                    FILE_FLAG_FIRST_PIPE_INSTANCE
                } else {
                    0
                },
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            33,
            4096,
            4096,
            0,
            &attributes,
        )
    })?;
    Ok(File::from(handle))
}

fn connected(pipe: &File) -> io::Result<bool> {
    // SAFETY: The pipe uses nonblocking mode, so this synchronous call cannot block the service loop.
    if unsafe { ConnectNamedPipe(pipe.as_raw_handle(), ptr::null_mut()) } != 0 {
        return Ok(true);
    }
    match io::Error::last_os_error()
        .raw_os_error()
        .map(|code| code as u32)
    {
        Some(ERROR_PIPE_CONNECTED) => Ok(true),
        Some(ERROR_PIPE_LISTENING | ERROR_NO_DATA) => Ok(false),
        _ => Err(io::Error::last_os_error()),
    }
}

fn authenticate_client(pipe: &File) -> io::Result<OwnedHandle> {
    let mut pid = 0;
    // SAFETY: The connected local pipe reports its actual kernel peer, not a client-supplied PID.
    boolean(unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) })?;
    // SAFETY: Query/synchronize access pins the process identity without granting process mutation.
    let process = owned(unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION
                | PROCESS_SYNCHRONIZE
                | windows_sys::Win32::System::Threading::PROCESS_DUP_HANDLE,
            0,
            pid,
        )
    })?;
    require_host(process.as_raw_handle(), false)?;
    if fs::canonicalize(process_image(process.as_raw_handle())?)?
        != fs::canonicalize(setup::installed_path()?)?
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(process)
}

fn handle_client(client: &mut Client, network: &Network) -> io::Result<bool> {
    // SAFETY: The handle pins the authenticated client's lifetime, eliminating PID reuse.
    if unsafe { WaitForSingleObject(client.owner.as_raw_handle(), 0) } == WAIT_OBJECT_0 {
        return Ok(false);
    }
    let available = available(&client.pipe)?;
    match &mut client.state {
        State::Preparing | State::Active { .. } => Ok(available == 0),
        State::Pending { bytes, deadline } => {
            if Instant::now() >= *deadline || available as usize > REQUEST_LIMIT {
                return Ok(false);
            }
            if available == 0 {
                return Ok(true);
            }
            let mut buffer = vec![0; available as usize];
            let count = client.pipe.read(&mut buffer)?;
            bytes.extend_from_slice(&buffer[..count]);
            if bytes.len() > REQUEST_LIMIT {
                return Ok(false);
            }
            let Some(end) = bytes.iter().position(|byte| *byte == b'\n') else {
                return Ok(true);
            };
            if end + 1 != bytes.len() {
                return Ok(false);
            }
            let request: Request =
                serde_json::from_slice(&bytes[..end]).map_err(|_| io::ErrorKind::InvalidData)?;
            match request {
                Request::Health { protocol } if protocol == PROTOCOL_VERSION => {
                    let owner =
                        crate::windows_security::process_user_sid(client.owner.as_raw_handle())?;
                    let healthy = super::account::owner_matches(&owner)?;
                    writeln!(client.pipe, "{}", serde_json::json!({ "healthy": healthy }))?;
                    return Ok(false);
                }
                Request::Account { protocol, grants } if protocol == PROTOCOL_VERSION => {
                    let owner =
                        crate::windows_security::process_user_sid(client.owner.as_raw_handle())?;
                    let account = super::account::for_owner(&owner)?;
                    network.ensure_account(&account.sid)?;
                    super::acl_state::remember(&owner, &account, &grants)?;
                    let job = super::process::Job::new()?;
                    let security = SecurityDescriptor::new(&format!(
                        "D:P(A;;GA;;;SY)(A;;GA;;;{})",
                        super::security::sid_text(&owner)?
                    ))?;
                    // SAFETY: The fresh job has no processes and grants control only to SYSTEM and this authenticated supervisor's owner.
                    boolean(unsafe {
                        SetKernelObjectSecurity(
                            job.0.as_raw_handle(),
                            DACL_SECURITY_INFORMATION,
                            security.as_ptr(),
                        )
                    })?;
                    let handle = RemoteHandle::new(&client.owner, job.0.as_raw_handle())?;
                    let mut reply = serde_json::to_vec(
                        &serde_json::json!({ "sid": account.sid, "group": account.group_sid, "job": handle.value as usize, "name": job.name() }),
                    )?;
                    reply.push(b'\n');
                    client.pipe.write_all(&reply)?;
                    handle.handoff();
                    job.handoff();
                    client.state = State::Preparing;
                    return Ok(true);
                }
                Request::Launch { protocol, command } if protocol == PROTOCOL_VERSION => {
                    let owner =
                        crate::windows_security::process_user_sid(client.owner.as_raw_handle())?;
                    let account = super::account::for_owner(&owner)?;
                    network.verify_account(&account.sid)?;
                    let (child, job) =
                        super::process::launch(&command, client.owner.as_raw_handle(), &account)?;
                    let process = RemoteHandle::new(&client.owner, child.process.as_raw_handle())?;
                    let thread = RemoteHandle::new(&client.owner, child.thread.as_raw_handle())?;
                    client.state = State::Active { child, job };
                    let mut reply = serde_json::to_vec(
                        &serde_json::json!({ "process": process.value as usize, "thread": thread.value as usize }),
                    )?;
                    reply.push(b'\n');
                    client.pipe.write_all(&reply)?;
                    process.handoff();
                    thread.handoff();
                }
                _ => return Ok(false),
            }
            Ok(true)
        }
    }
}

struct RemoteHandle<'a> {
    owner: &'a OwnedHandle,
    value: windows_sys::Win32::Foundation::HANDLE,
    transferred: bool,
}

impl<'a> RemoteHandle<'a> {
    fn new(
        owner: &'a OwnedHandle,
        source: windows_sys::Win32::Foundation::HANDLE,
    ) -> io::Result<Self> {
        Ok(Self {
            owner,
            value: super::process::duplicate(
                current_process(),
                source,
                owner.as_raw_handle(),
                false,
            )?,
            transferred: false,
        })
    }

    fn handoff(mut self) {
        self.transferred = true;
    }
}

impl Drop for RemoteHandle<'_> {
    fn drop(&mut self) {
        if self.transferred {
            return;
        }
        let mut local = ptr::null_mut();
        // SAFETY: The pinned recipient owns this unpublished duplicate; failed publication must close it in that process.
        if unsafe {
            windows_sys::Win32::Foundation::DuplicateHandle(
                self.owner.as_raw_handle(),
                self.value,
                current_process(),
                &mut local,
                0,
                0,
                windows_sys::Win32::Foundation::DUPLICATE_CLOSE_SOURCE
                    | windows_sys::Win32::Foundation::DUPLICATE_SAME_ACCESS,
            )
        } != 0
        {
            drop(owned(local));
        }
    }
}

pub(super) struct Lease(File);
impl Lease {
    pub(super) fn account(
        grants: Vec<super::filesystem::Grant>,
    ) -> io::Result<(
        Self,
        crate::windows_security::Sid,
        crate::windows_security::Sid,
        super::process::Job,
    )> {
        let (lease, reply) = Self::request(Request::Account {
            protocol: PROTOCOL_VERSION,
            grants,
        })?;
        let handle = owned(
            reply
                .get("job")
                .and_then(serde_json::Value::as_u64)
                .ok_or(io::ErrorKind::InvalidData)?
                as windows_sys::Win32::Foundation::HANDLE,
        )?;
        let name = reply
            .get("name")
            .and_then(serde_json::Value::as_str)
            .ok_or(io::ErrorKind::InvalidData)?;
        let sid = super::account::parse_sid(
            reply
                .get("sid")
                .and_then(serde_json::Value::as_str)
                .ok_or(io::ErrorKind::InvalidData)?,
        )?;
        let group = super::account::parse_sid(
            reply
                .get("group")
                .and_then(serde_json::Value::as_str)
                .ok_or(io::ErrorKind::InvalidData)?,
        )?;
        Ok((
            lease,
            sid,
            group,
            super::process::Job::received(handle, name.to_owned()),
        ))
    }

    pub(super) fn connect(command: LaunchRequest) -> io::Result<(Self, Child)> {
        let (lease, reply) = Self::request(Request::Launch {
            protocol: PROTOCOL_VERSION,
            command,
        })?;
        let handle = |name: &str| -> io::Result<OwnedHandle> {
            let value = reply
                .get(name)
                .and_then(serde_json::Value::as_u64)
                .ok_or(io::ErrorKind::InvalidData)?;
            owned(value as windows_sys::Win32::Foundation::HANDLE)
        };
        Ok((
            lease,
            Child {
                process: handle("process")?,
                thread: handle("thread")?,
            },
        ))
    }

    pub(super) fn health() -> io::Result<i32> {
        require_host(current_process(), false)?;
        setup::configuration_valid(&setup::installed_path()?)?;
        let (_, reply) = Self::request(Request::Health {
            protocol: PROTOCOL_VERSION,
        })?;
        match reply.get("healthy").and_then(serde_json::Value::as_bool) {
            Some(true) => Ok(0),
            Some(false) => {
                eprintln!(
                    "{}",
                    serde_json::json!({"type":"error","code":"SANDBOX_NEEDS_UPDATE","nativeCode":null})
                );
                Ok(125)
            }
            None => Err(io::ErrorKind::InvalidData.into()),
        }
    }

    fn request(request: Request) -> io::Result<(Self, serde_json::Value)> {
        at("service_start", setup::start_service())?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut pipe = loop {
            let result = OpenOptions::new()
                .access_mode(FILE_GENERIC_READ | FILE_WRITE_DATA)
                .custom_flags(
                    windows_sys::Win32::Storage::FileSystem::SECURITY_SQOS_PRESENT
                        | windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION,
                )
                .open(PIPE_NAME);
            match result {
                Ok(pipe) => break pipe,
                Err(error) if Instant::now() >= deadline => return at("pipe_connect", Err(error)),
                Err(_) => std::thread::sleep(Duration::from_millis(25)),
            }
        };
        at("service_identity", authenticate_server(&pipe))?;
        let mut message = serde_json::to_vec(&request)?;
        message.push(b'\n');
        pipe.write_all(&message)?;
        let mut reply = Vec::new();
        loop {
            if Instant::now() >= deadline || reply.len() > 1024 {
                return Err(io::ErrorKind::TimedOut.into());
            }
            let count = available(&pipe)?;
            if count == 0 {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            let mut bytes = vec![0; (count as usize).min(1024)];
            let count = pipe.read(&mut bytes)?;
            reply.extend_from_slice(&bytes[..count]);
            if reply.last() == Some(&b'\n') {
                let value: serde_json::Value = serde_json::from_slice(&reply)?;
                if let Some(error) = value.get("error").and_then(serde_json::Value::as_i64) {
                    if let Some(phase) = value.get("phase").and_then(serde_json::Value::as_str) {
                        eprintln!(
                            "{}",
                            serde_json::json!({ "type": "diagnostic", "phase": phase, "nativeCode": error })
                        );
                    }
                    return Err(io::Error::from_raw_os_error(error as i32));
                }
                return Ok((Self(pipe), value));
            }
        }
    }

    pub(super) fn alive(&self) -> bool {
        available(&self.0).is_ok_and(|count| count == 0)
    }

    pub(super) fn finish(mut self) -> io::Result<()> {
        self.0.write_all(b"close\n")?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while available(&self.0)? < 5 {
            if Instant::now() >= deadline {
                return Err(io::ErrorKind::TimedOut.into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let mut reply = [0; 5];
        self.0.read_exact(&mut reply)?;
        if reply != *b"done\n" {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(())
    }
}

fn authenticate_server(pipe: &File) -> io::Result<()> {
    let mut pid = 0;
    at(
        "server_pid",
        // SAFETY: The pipe reports the actual connected server PID.
        boolean(unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) }),
    )?;
    // SAFETY: Query-only process access is sufficient to verify the server identity.
    let process = at(
        "server_process",
        owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) }),
    )?;
    if pid != setup::service_pid()?
        || fs::canonicalize(process_image(process.as_raw_handle())?)?
            != fs::canonicalize(setup::installed_path()?)?
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

fn available(pipe: &File) -> io::Result<u32> {
    let mut count = 0;
    // SAFETY: The connected pipe is live; no data is consumed and the byte-count output is writable.
    boolean(unsafe {
        PeekNamedPipe(
            pipe.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            &mut count,
            ptr::null_mut(),
        )
    })?;
    Ok(count)
}
