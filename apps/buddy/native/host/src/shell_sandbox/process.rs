use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::windows::io::{AsRawHandle, OwnedHandle},
    path::Path,
    ptr,
    time::{Duration, Instant},
};

use serde::Deserialize;
use windows_sys::Win32::{
    Foundation::{
        DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_ALREADY_EXISTS, GetLastError, WAIT_OBJECT_0,
    },
    Security::{SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES},
    Storage::FileSystem::FILE_GENERIC_READ,
    System::{
        Console::{GetStdHandle, STD_OUTPUT_HANDLE},
        JobObjects::*,
        SystemServices::SE_GROUP_ENABLED,
        Threading::*,
    },
};

use super::{
    broker::Lease,
    cancellation::Cancellation,
    filesystem::{Access, Grant, Grants, inspect},
    metadata,
    security::{Profile, at, boolean, capability, current_process, owned, require_host, wide},
    setup,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    command: String,
    cwd: String,
    shell: String,
    private_root: String,
    environment: BTreeMap<String, String>,
    grants: Vec<Grant>,
    proxy_port: u16,
}

pub(super) fn run() -> io::Result<i32> {
    require_host(current_process(), false)?;
    let job = at("job", Job::new())?;
    eprintln!(
        "{}",
        serde_json::json!({"type":"supervisor","protocol":1,"identity":crate::supervised_shell::windows::identity(&job)?})
    );
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
    let request: Request = serde_json::from_slice(&bytes)?;
    let cancellation = Cancellation::listen(input);
    cancellation.check()?;
    validate(&request)?;
    let profile = at("profile", Profile::create())?;
    let mut policy = request.grants;
    policy.push(inspect(&request.private_root, Access::Write)?);
    eprintln!(
        "{}",
        serde_json::json!({"type":"diagnostic","phase":"filesystem_preparing","nativeCode":null})
    );
    let mut grants = at(
        "filesystem",
        Grants::apply(&profile, &policy, &cancellation),
    )?;
    cancellation.check()?;
    let script = Path::new(&request.private_root).join("command.ps1");
    let mut script_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&script)?;
    script_file.write_all(
        b"\xef\xbb\xbftry { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n",
    )?;
    script_file.write_all(request.command.as_bytes())?;
    script_file.write_all(
        b"\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }\n",
    )?;
    drop(script_file);
    cancellation.check()?;
    let lease = at(
        "boundary",
        Lease::connect(&profile.name, request.proxy_port, metadata::roots(&policy)),
    )?;
    cancellation.check()?;
    let child = at(
        "launch",
        launch(
            &profile,
            &job,
            &request.shell,
            &script,
            &request.cwd,
            &request.environment,
        ),
    )?;
    at(
        "verify_boundary",
        super::policy::verify_denials(child.process.as_raw_handle(), &policy, &cancellation),
    )?;
    cancellation.check()?;
    eprintln!(
        "{}",
        serde_json::json!({"type":"ready","protocol":super::PROTOCOL_VERSION})
    );
    // SAFETY: The process is still suspended, already confined to its AppContainer and kill-on-close job.
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
    eprintln!(
        "{}",
        serde_json::json!({"type":"processesReleased","protocol":1})
    );
    drop(child);
    drop(job);
    lease.finish()?;
    grants.finish()?;
    drop(grants);
    drop(profile);
    result
}

fn validate(request: &Request) -> io::Result<()> {
    for path in [&request.cwd, &request.shell, &request.private_root] {
        if !crate::windows_path::valid(path) || path.starts_with(r"\\") {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    let shell = Path::new(&request.shell)
        .file_name()
        .ok_or(io::ErrorKind::InvalidInput)?
        .to_string_lossy();
    if !["powershell.exe", "pwsh.exe"]
        .iter()
        .any(|name| name.eq_ignore_ascii_case(&shell))
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

pub(crate) struct Job(pub(crate) OwnedHandle, String);
impl Job {
    fn new() -> io::Result<Self> {
        Self::create(true)
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
        let job = Self(handle, name);
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
        if self.finish().is_err() {
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

fn launch(
    profile: &Profile,
    job: &Job,
    shell: &str,
    script: &Path,
    cwd: &str,
    environment: &BTreeMap<String, String>,
) -> io::Result<Child> {
    let mut inherited_output = ptr::null_mut();
    // SAFETY: Only a duplicate of stdout is made inheritable; the control pipe and job handle remain private.
    boolean(unsafe {
        DuplicateHandle(
            current_process(),
            GetStdHandle(STD_OUTPUT_HANDLE),
            current_process(),
            &mut inherited_output,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    })?;
    let output = owned(inherited_output)?;
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
    let registry = capability("registryRead")?;
    let com = capability("lpacCom")?;
    let instrumentation = capability("lpacInstrumentation")?;
    let internet = capability("internetClientServer")?;
    let volume_metadata = metadata::capability(&profile.name)?;
    let mut entries = [
        &registry,
        &com,
        &instrumentation,
        &internet,
        &volume_metadata,
    ]
    .map(|sid| SID_AND_ATTRIBUTES {
        Sid: sid.as_ptr(),
        Attributes: SE_GROUP_ENABLED as u32,
    });
    let capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: profile.sid.as_ptr(),
        Capabilities: entries.as_mut_ptr(),
        CapabilityCount: entries.len() as u32,
        Reserved: 0,
    };
    let mut attribute_list = Attributes::new(3)?;
    let application_packages_policy = 1u32;
    attribute_list.set(
        PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY as usize,
        &application_packages_policy,
    )?;
    attribute_list.set(
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
        &capabilities,
    )?;
    attribute_list.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, &handles)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input.as_raw_handle();
    startup.StartupInfo.hStdOutput = output.as_raw_handle();
    startup.StartupInfo.hStdError = output.as_raw_handle();
    startup.lpAttributeList = attribute_list.pointer();
    let mut command = wide(&format!(
        "\"{shell}\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"",
        script.display()
    ));
    let mut environment: Vec<u16> = environment
        .iter()
        .flat_map(|(key, value)| wide(&format!("{key}={value}")))
        .chain([0])
        .collect();
    let mut information = PROCESS_INFORMATION::default();
    // SAFETY: All startup/attribute/environment buffers stay live; the child starts suspended with an explicit two-handle inheritance list.
    boolean(unsafe {
        CreateProcessW(
            wide(shell).as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | CREATE_SUSPENDED,
            environment.as_mut_ptr().cast(),
            wide(cwd).as_ptr(),
            &startup.StartupInfo,
            &mut information,
        )
    })?;
    let child = Child {
        process: owned(information.hProcess)?,
        thread: owned(information.hThread)?,
    };
    // SAFETY: The child is suspended and cannot create descendants before this job assignment completes.
    boolean(unsafe {
        AssignProcessToJobObject(job.0.as_raw_handle(), child.process.as_raw_handle())
    })?;
    Ok(child)
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
