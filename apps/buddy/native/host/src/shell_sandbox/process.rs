use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::windows::io::{AsRawHandle, OwnedHandle},
    path::Path,
    ptr,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use windows_sys::Win32::{
    Foundation::{
        DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE,
        WAIT_OBJECT_0,
    },
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::FILE_GENERIC_READ,
    System::{
        Console::{GetStdHandle, STD_OUTPUT_HANDLE},
        JobObjects::*,
        Threading::*,
    },
};

use super::{
    acl_state::DenialUpdate,
    broker::Lease,
    cancellation::Cancellation,
    filesystem::{Access, Grant, Grants, inspect},
    security::{at, boolean, current_process, owned, require_host, wide},
    setup,
    shell_program::Dialect,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    command: String,
    cwd: String,
    shell: String,
    #[serde(default)]
    dialect: Dialect,
    private_root: String,
    environment: BTreeMap<String, String>,
    grants: Vec<Grant>,
    #[serde(default)]
    deny_read_scope: Option<String>,
    proxy_port: u16,
    launch: crate::supervised_shell::receipt::Launch,
}

pub(super) fn run() -> io::Result<i32> {
    require_host(current_process(), false)?;
    if fs::canonicalize(std::env::current_exe()?)? != fs::canonicalize(setup::installed_path()?)? {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut input = BufReader::new(io::stdin());
    let mut bytes = Vec::new();
    (&mut input)
        .take(2 * 1024 * 1024 + 1)
        .read_until(b'\n', &mut bytes)?;
    if bytes.len() > 2 * 1024 * 1024 || bytes.last() != Some(&b'\n') {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut request: Request = serde_json::from_slice(&bytes)?;
    validate(&request)?;
    super::filesystem::add_traversal_grants(&mut request.grants)?;
    request.launch.validate()?;
    let (preparation, account, group, job) = at(
        "job",
        Lease::account(
            request
                .grants
                .iter()
                .filter(|grant| !super::policy::contains(&request.private_root, &grant.path))
                .cloned()
                .collect(),
        ),
    )?;
    let mut identity = crate::supervised_shell::windows::identity(&job)?;
    identity["version"] = serde_json::json!(3);
    identity["executionId"] = serde_json::json!(request.launch.execution_id);
    identity["dispatchId"] = serde_json::json!(request.launch.dispatch_id);
    let receipt = crate::supervised_shell::receipt::Receipt::prepare(&request.launch, &identity)?;
    eprintln!(
        "{}",
        serde_json::json!({"type":"supervisor","protocol":1,"identity":identity})
    );
    let mut launch_sealed = true;
    let result = (|| -> io::Result<i32> {
        let mut ack = Vec::new();
        (&mut input).take(1025).read_until(b'\n', &mut ack)?;
        let accepted = serde_json::from_slice::<LaunchAck>(&ack).is_ok_and(|ack| {
            ack.execution_id == request.launch.execution_id
                && ack.dispatch_id == request.launch.dispatch_id
        });
        if !accepted || ack.len() > 1024 || ack.last() != Some(&b'\n') {
            return Err(io::ErrorKind::Interrupted.into());
        }
        let cancellation = Cancellation::listen(input, Duration::from_secs(60));
        cancellation.check()?;
        let mut policy = request.grants;
        policy.push(inspect(&request.private_root, Access::Write)?);
        eprintln!(
            "{}",
            serde_json::json!({"type":"diagnostic","phase":"filesystem_preparing","nativeCode":null})
        );
        let grants = at(
            "filesystem",
            Grants::apply(
                &account,
                &group,
                &policy,
                &cancellation,
                request.deny_read_scope.as_deref().map(DenialUpdate::Merge),
            ),
        )?;
        cancellation.check()?;
        let script = Path::new(&request.private_root)
            .join(format!("command.{}", request.dialect.extension()));
        if request.dialect != Dialect::Cmd {
            let mut script_file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&script)?;
            script_file.write_all(&request.dialect.script(&request.command))?;
        }
        cancellation.check()?;
        launch_sealed = false;
        let (lease, child) = at(
            "launch",
            Lease::connect(LaunchRequest {
                shell: request.shell,
                dialect: request.dialect,
                command: (request.dialect == Dialect::Cmd).then_some(request.command),
                script: script.to_string_lossy().into_owned(),
                cwd: request.cwd,
                environment: request.environment,
                capabilities: grants.capabilities.clone(),
                job: job.0.as_raw_handle() as usize,
                // SAFETY: stdout belongs to the supervisor; the authenticated broker duplicates it without inheriting control input.
                output: unsafe { GetStdHandle(STD_OUTPUT_HANDLE) } as usize,
            }),
        )?;
        preparation.finish()?;
        cancellation.check()?;
        eprintln!(
            "{}",
            serde_json::json!({"type":"ready","protocol":super::PROTOCOL_VERSION})
        );
        // SAFETY: The process is still suspended, already confined to its restricted token and kill-on-close job.
        if unsafe { ResumeThread(child.thread.as_raw_handle()) } == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        let deadline = Instant::now() + Duration::from_secs(86400);
        let result = loop {
            if cancellation.cancelled() || !lease.alive() || Instant::now() >= deadline {
                break Err(io::ErrorKind::Interrupted.into());
            }
            // SAFETY: The process handle is live and queryable throughout this bounded wait.
            if unsafe { WaitForSingleObject(child.process.as_raw_handle(), 25) } == WAIT_OBJECT_0 {
                let mut code = 0;
                // SAFETY: The process finished and the exit-code output is writable.
                boolean(unsafe { GetExitCodeProcess(child.process.as_raw_handle(), &mut code) })?;
                break Ok(code as i32);
            }
        };
        job.finish()?;
        drop(child);
        lease.finish()?;
        launch_sealed = true;
        drop(grants);
        result
    })();
    job.finish()?;
    if launch_sealed {
        if let Some(receipt) = &receipt {
            receipt.release()?;
        }
        eprintln!(
            "{}",
            serde_json::json!({"type":"processesReleased","protocol":1})
        );
    }
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchAck {
    execution_id: String,
    dispatch_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Preparation {
    grants: Vec<Grant>,
    #[serde(default, rename = "denyReadScope")]
    deny_read_scope: Option<String>,
    #[serde(default, rename = "synchronizeDenials")]
    synchronize_denials: bool,
    #[serde(default)]
    background: bool,
}

pub(super) fn prepare() -> io::Result<i32> {
    require_host(current_process(), false)?;
    if fs::canonicalize(std::env::current_exe()?)? != fs::canonicalize(setup::installed_path()?)? {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut input = BufReader::new(io::stdin());
    let mut bytes = Vec::new();
    (&mut input)
        .take(2 * 1024 * 1024 + 1)
        .read_until(b'\n', &mut bytes)?;
    if bytes.len() > 2 * 1024 * 1024 || bytes.last() != Some(&b'\n') {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut request: Preparation = serde_json::from_slice(&bytes)?;
    super::filesystem::add_traversal_grants(&mut request.grants)?;
    if request.background {
        use windows_sys::Win32::System::Threading::{
            PROCESS_MODE_BACKGROUND_BEGIN, SetPriorityClass,
        };
        // SAFETY: Only this preparation process enters background mode; no task command runs here.
        boolean(unsafe { SetPriorityClass(current_process(), PROCESS_MODE_BACKGROUND_BEGIN) })?;
    }
    let (preparation, account, group, job) = at("job", Lease::account(request.grants.clone()))?;
    eprintln!(
        "{}",
        serde_json::json!({"type":"supervisor","protocol":1,"identity":crate::supervised_shell::windows::identity(&job)?})
    );
    let cancellation = Cancellation::listen(input, Duration::from_secs(900));
    eprintln!(
        "{}",
        serde_json::json!({"type":"diagnostic","phase":"filesystem_preparing","nativeCode":null})
    );
    let _grants = at(
        "filesystem",
        Grants::apply(
            &account,
            &group,
            &request.grants,
            &cancellation,
            request.deny_read_scope.as_deref().map(|scope| {
                if request.synchronize_denials {
                    DenialUpdate::Replace(scope)
                } else {
                    DenialUpdate::Merge(scope)
                }
            }),
        ),
    )?;
    cancellation.check()?;
    preparation.finish()?;
    job.finish()?;
    eprintln!(
        "{}",
        serde_json::json!({"type":"processesReleased","protocol":1})
    );
    eprintln!("{}", serde_json::json!({"type":"ready","protocol":1}));
    Ok(0)
}

fn validate(request: &Request) -> io::Result<()> {
    for path in [&request.cwd, &request.shell, &request.private_root] {
        if !crate::windows_path::valid(path) || path.starts_with(r"\\") {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    request.dialect.validate(&request.shell)?;
    if (request.dialect == Dialect::Cmd && request.command.contains(['\r', '\n']))
        || request.command.is_empty()
        || request.command.len() > 1024 * 1024
        || request.command.contains('\0')
        || request.environment.len() > 128
        || request.proxy_port == 0
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut size = 0;
    for (name, value) in &request.environment {
        if name.is_empty() || name.contains(['=', '\0']) || value.contains('\0') {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        size += name.encode_utf16().count() + value.encode_utf16().count() + 2;
    }
    if size > 32760 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(())
}

pub(crate) struct Job(pub(crate) OwnedHandle, String, bool);
impl Job {
    pub(super) fn new() -> io::Result<Self> {
        Self::create(true)
    }

    pub(super) fn received(handle: OwnedHandle, name: String) -> Self {
        Self(handle, name, true)
    }

    pub(super) fn handoff(mut self) {
        self.2 = false;
    }

    pub(crate) fn host() -> io::Result<Self> {
        Self::create(false)
    }

    pub(crate) fn name(&self) -> &str {
        &self.1
    }

    fn create(restrict_ui: bool) -> io::Result<Self> {
        let name = format!(
            "{}{}",
            crate::supervised_shell::recovery::WINDOWS_JOB_PREFIX,
            uuid::Uuid::new_v4()
        );
        // SAFETY: A non-inheritable job handle never enters the child's handle list.
        let handle = unsafe { CreateJobObjectW(ptr::null(), wide(&name).as_ptr()) };
        // SAFETY: Read the creation result before any other Windows API can replace it.
        let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let handle = owned(handle)?;
        if existed {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
        let job = Self(handle, name, true);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: The live job receives an initialized limits struct; breakaway is deliberately absent.
        boolean(unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                ptr::from_ref(&limits).cast(),
                size_of_val(&limits) as u32,
            )
        })?;
        if !restrict_ui {
            return Ok(job);
        }
        let restrictions = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: JOB_OBJECT_UILIMIT_HANDLES
                | JOB_OBJECT_UILIMIT_READCLIPBOARD
                | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
                | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                | JOB_OBJECT_UILIMIT_GLOBALATOMS
                | JOB_OBJECT_UILIMIT_DESKTOP
                | JOB_OBJECT_UILIMIT_EXITWINDOWS,
        };
        // SAFETY: Shell execution does not need host desktop, clipboard or window privileges.
        boolean(unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectBasicUIRestrictions,
                ptr::from_ref(&restrictions).cast(),
                size_of_val(&restrictions) as u32,
            )
        })?;
        Ok(job)
    }

    pub(crate) fn finish(&self) -> io::Result<()> {
        // SAFETY: This private job contains only this command and its descendants.
        boolean(unsafe { TerminateJobObject(self.0.as_raw_handle(), 125) })?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            // SAFETY: The job remains live and the output matches the queried information class.
            boolean(unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    ptr::from_mut(&mut accounting).cast(),
                    size_of_val(&accounting) as u32,
                    ptr::null_mut(),
                )
            })?;
            if accounting.ActiveProcesses == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::ErrorKind::TimedOut.into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if self.2 && self.finish().is_err() {
            // Preserve the recovery journal rather than remove grants while a descendant may still be exiting.
            std::process::exit(125);
        }
    }
}

pub(crate) struct Child {
    pub(crate) process: OwnedHandle,
    pub(crate) thread: OwnedHandle,
}
impl Drop for Child {
    fn drop(&mut self) {
        // SAFETY: This owned process handle is the exact newly created child; also covers pre-job launch failures.
        unsafe { TerminateProcess(self.process.as_raw_handle(), 125) };
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LaunchRequest {
    pub(super) shell: String,
    #[serde(default)]
    pub(super) dialect: Dialect,
    #[serde(default)]
    pub(super) command: Option<String>,
    pub(super) script: String,
    pub(super) cwd: String,
    pub(super) environment: BTreeMap<String, String>,
    pub(super) capabilities: Vec<String>,
    pub(super) job: usize,
    pub(super) output: usize,
}

pub(super) fn duplicate(
    source: HANDLE,
    handle: HANDLE,
    destination: HANDLE,
    inherit: bool,
) -> io::Result<HANDLE> {
    let mut output = ptr::null_mut();
    // SAFETY: The source/destination are authenticated live process handles; only explicitly supplied handles are copied.
    boolean(unsafe {
        DuplicateHandle(
            source,
            handle,
            destination,
            &mut output,
            0,
            i32::from(inherit),
            DUPLICATE_SAME_ACCESS,
        )
    })?;
    Ok(output)
}

#[derive(Debug)]
pub(super) struct LaunchError {
    pub(super) phase: &'static str,
    pub(super) source: io::Error,
}
impl std::fmt::Display for LaunchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.phase)
    }
}
impl std::error::Error for LaunchError {}
fn launch_phase<T>(phase: &'static str, result: io::Result<T>) -> io::Result<T> {
    result.map_err(|source| io::Error::new(source.kind(), LaunchError { phase, source }))
}

pub(super) fn launch(
    request: &LaunchRequest,
    client: HANDLE,
    account: &super::account::Account,
) -> io::Result<(Child, OwnedHandle)> {
    if request.capabilities.is_empty()
        || request.environment.len() > 128
        || request.script.contains(['\0', '"'])
        || request.shell.contains(['\0', '"'])
        || request.cwd.contains('\0')
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    request.dialect.validate(&request.shell)?;
    let command_line = request.dialect.command_line(
        &request.shell,
        &request.script,
        request.command.as_deref(),
    )?;
    if command_line.encode_utf16().count() >= 32767 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let base = launch_phase("account_logon", account.logon())?;
    let owner = crate::windows_security::process_user_sid(client)?;
    let token = launch_phase(
        "restrict_token",
        super::token::restrict(
            base.as_raw_handle(),
            &request.capabilities,
            &owner,
            &super::account::parse_sid(&account.sid)?,
        ),
    )?;
    let job = owned(duplicate(
        client,
        request.job as HANDLE,
        current_process(),
        false,
    )?)?;
    let output = owned(duplicate(
        client,
        request.output as HANDLE,
        current_process(),
        true,
    )?)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    // SAFETY: NUL is a fixed device providing EOF; it cannot expose the supervisor's control input.
    let input = owned(unsafe {
        windows_sys::Win32::Storage::FileSystem::CreateFileW(
            wide("NUL").as_ptr(),
            FILE_GENERIC_READ,
            3,
            &attributes,
            windows_sys::Win32::Storage::FileSystem::OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    })?;
    let handles = [input.as_raw_handle(), output.as_raw_handle()];
    let mut attribute_list = Attributes::new(1)?;
    attribute_list.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, &handles)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input.as_raw_handle();
    startup.StartupInfo.hStdOutput = output.as_raw_handle();
    startup.StartupInfo.hStdError = output.as_raw_handle();
    startup.lpAttributeList = attribute_list.pointer();
    let mut command = wide(&command_line);
    let mut environment: Vec<u16> = request
        .environment
        .iter()
        .flat_map(|(key, value)| wide(&format!("{key}={value}")))
        .chain([0])
        .collect();
    let mut information = PROCESS_INFORMATION::default();
    launch_phase(
        "create_process",
        // SAFETY: All startup buffers stay live; the child starts suspended with an explicit handle inheritance list.
        boolean(unsafe {
            CreateProcessAsUserW(
                token.as_raw_handle(),
                wide(&request.shell).as_ptr(),
                command.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT
                    | CREATE_UNICODE_ENVIRONMENT
                    | CREATE_NO_WINDOW
                    | CREATE_SUSPENDED,
                environment.as_mut_ptr().cast(),
                wide(&request.cwd).as_ptr(),
                &startup.StartupInfo,
                &mut information,
            )
        }),
    )?;
    let child = Child {
        process: owned(information.hProcess)?,
        thread: owned(information.hThread)?,
    };
    launch_phase(
        "assign_job",
        // SAFETY: The suspended child cannot create descendants before assignment to the job created in the same session.
        boolean(unsafe {
            AssignProcessToJobObject(job.as_raw_handle(), child.process.as_raw_handle())
        }),
    )?;
    Ok((child, job))
}

pub(crate) struct Attributes {
    storage: Vec<usize>,
}
impl Attributes {
    pub(crate) fn new(count: u32) -> io::Result<Self> {
        let mut size = 0;
        // SAFETY: The first sizing call accepts a null list and writes the required allocation size.
        unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), count, 0, &mut size) };
        if size == 0 || size > 65536 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
        // SAFETY: Pointer-aligned storage has the API-reported capacity and stays owned until deletion.
        boolean(unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), count, 0, &mut size)
        })?;
        Ok(Self { storage })
    }

    pub(crate) fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }

    pub(crate) fn set<T>(&mut self, key: usize, value: &T) -> io::Result<()> {
        // SAFETY: Each caller keeps its attribute data alive until CreateProcess returns; the list owns sufficient storage.
        boolean(unsafe {
            UpdateProcThreadAttribute(
                self.pointer(),
                0,
                key,
                ptr::from_ref(value).cast(),
                size_of::<T>(),
                ptr::null_mut(),
                ptr::null(),
            )
        })
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: This is the matching deletion of the initialized list before releasing its backing allocation.
        unsafe { DeleteProcThreadAttributeList(self.pointer()) };
    }
}
