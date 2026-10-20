use super::*;
use crate::shell_sandbox::process::Job;
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle},
    System::{
        JobObjects::{
            AssignProcessToJobObject, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
        Threading::GetCurrentProcess,
    },
};

fn job_identity(job: &Job) -> Value {
    let mut identity = crate::supervised_shell::windows::identity(job).unwrap();
    identity["kind"] = json!("native-shell");
    identity["platform"] = json!("win32");
    identity["nonce"] = json!("test-handshake");
    identity
}

#[test]
fn windows_live_supervisor_keeps_an_empty_job_active() {
    let job = Job::host().unwrap();
    assert_eq!(
        inspect(job_identity(&job), None)["reason"],
        "supervisor_active"
    );
}

#[test]
fn windows_reused_pid_and_an_empty_held_job_cannot_prove_a_sealed_launch_domain() {
    let job = Job::host().unwrap();
    let mut identity = job_identity(&job);
    identity["startTime"] = json!("0");
    assert_eq!(
        inspect(identity, None),
        json!({"protocol":1,"status":"unknown","reason":"job_boundary_unverified"})
    );
}

#[test]
fn windows_missing_job_stays_unknown_even_when_the_supervisor_is_gone() {
    let job = Job::host().unwrap();
    let mut identity = job_identity(&job);
    identity["startTime"] = json!("0");
    drop(job);
    assert_eq!(inspect(identity, None)["reason"], "job_not_found");
}

#[test]
fn windows_incomplete_job_identity_cannot_use_a_boot_checkpoint() {
    let job = Job::host().unwrap();
    let mut identity = job_identity(&job);
    identity.as_object_mut().unwrap().remove("jobName");
    assert_eq!(
        inspect(identity, Some(prior_checkpoint()))["reason"],
        "identity_incomplete"
    );
}

#[test]
fn windows_legacy_supervisor_disappearance_alone_stays_unknown() {
    assert_eq!(inspect(identity(), None)["reason"], "legacy_identity");
}

#[test]
fn windows_job_with_breakaway_cannot_prove_descendant_release() {
    let job = Job::host().unwrap();
    let mut identity = job_identity(&job);
    identity["startTime"] = json!("0");
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    assert_ne!(
        // SAFETY: This test owns an empty job and the correctly sized limits buffer.
        unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                size_of_val(&limits) as u32,
            )
        },
        0
    );
    assert_eq!(inspect(identity, None)["reason"], "job_boundary_unverified");
}

#[test]
fn windows_job_query_access_denied_stays_unknown() {
    use windows_sys::Win32::Security::{
        ACL, ACL_REVISION, DACL_SECURITY_INFORMATION, InitializeAcl, InitializeSecurityDescriptor,
        SECURITY_DESCRIPTOR, SetKernelObjectSecurity, SetSecurityDescriptorDacl,
    };
    let job = Job::host().unwrap();
    let mut identity = job_identity(&job);
    identity["startTime"] = json!("0");
    let mut acl = ACL::default();
    assert_ne!(
        // SAFETY: This correctly sized empty ACL denies future opens, not the existing owned test handle.
        unsafe { InitializeAcl(&mut acl, size_of::<ACL>() as u32, ACL_REVISION) },
        0
    );
    let mut descriptor = SECURITY_DESCRIPTOR::default();
    let descriptor = std::ptr::from_mut(&mut descriptor).cast();
    // SAFETY: The native security descriptor is correctly sized, aligned and writable.
    assert_ne!(unsafe { InitializeSecurityDescriptor(descriptor, 1) }, 0);
    assert_ne!(
        // SAFETY: The descriptor and initialized empty ACL remain live for the subsequent setter.
        unsafe { SetSecurityDescriptorDacl(descriptor, 1, &acl, 0) },
        0
    );
    assert_ne!(
        // SAFETY: Only this test's private empty Job receives the temporary DACL.
        unsafe {
            SetKernelObjectSecurity(job.0.as_raw_handle(), DACL_SECURITY_INFORMATION, descriptor)
        },
        0
    );
    assert_eq!(
        inspect(identity, None),
        json!({"protocol":1,"status":"unknown","reason":"access_denied"})
    );
}

#[test]
fn windows_reverification_observes_a_remaining_child_without_terminating_it() {
    let job = Job::host().unwrap();
    let mut identity = job_identity(&job);
    identity["startTime"] = json!("0");
    let mut child = Command::new("cmd.exe")
        .args(["/D", "/Q", "/C", "set /p value="])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    assert_ne!(
        // SAFETY: The test owns both handles; the child only waits for input and does not create descendants.
        unsafe { AssignProcessToJobObject(job.0.as_raw_handle(), child.as_raw_handle()) },
        0
    );
    assert_eq!(
        inspect(identity.clone(), None),
        json!({"protocol":1,"status":"active","reason":"job_active"})
    );
    assert!(child.try_wait().unwrap().is_none());
    drop(child.stdin.take());
    child.wait().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = inspect(identity.clone(), None);
        if result["reason"] != "job_active" || Instant::now() >= deadline {
            assert_eq!(result["reason"], "job_boundary_unverified");
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn windows_non_inheritable_observer_can_hold_the_job_after_supervisor_release() {
    let job = Job::host().unwrap();
    let mut identity = job_identity(&job);
    identity["startTime"] = json!("0");
    let mut duplicate = std::ptr::null_mut();
    assert_ne!(
        // SAFETY: Duplicate only this test-owned job into this process, without inheritance.
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                job.0.as_raw_handle(),
                GetCurrentProcess(),
                &mut duplicate,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        },
        0
    );
    // SAFETY: DuplicateHandle returned a valid unique owned handle.
    let observer = unsafe { OwnedHandle::from_raw_handle(duplicate) };
    drop(job);
    assert_eq!(inspect(identity, None)["reason"], "job_boundary_unverified");
    drop(observer);
}
