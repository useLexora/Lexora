use super::super::security::SecurityDescriptor;
use super::*;
use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;

struct Accounts(Vec<Identity>);

impl Drop for Accounts {
    fn drop(&mut self) {
        for identity in self.0.iter().rev() {
            let _ = remove_identity(identity);
        }
    }
}

#[test]
#[ignore = "creates isolated local accounts; run explicitly with an elevated Windows token"]
fn account_recovery_preserves_same_named_replacements_and_resumes_durable_provisioning() {
    super::super::security::require_host(super::super::security::current_process(), true).unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("protected");
    let descriptor = SecurityDescriptor::new("O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)").unwrap();
    let attributes = descriptor.attributes(false);
    // SAFETY: This fresh test-only directory is administrator/SYSTEM-only from creation.
    boolean(unsafe { CreateDirectoryW(wide(&directory.to_string_lossy()).as_ptr(), &attributes) })
        .unwrap();
    let name = fresh_name().unwrap();
    let path = directory.join(format!("{name}.account"));
    let mut accounts = Accounts(Vec::new());
    let account = provision(
        &path,
        Account {
            name,
            password: format!("Lx9!{}{}", unique_id().unwrap(), unique_id().unwrap()),
            sid: String::new(),
            group_sid: String::new(),
            retired: Vec::new(),
        },
    )
    .unwrap();
    accounts.0.push(account.identity());
    assert!(account.matches().unwrap());

    let mut intent = Account::read(&path).unwrap();
    intent.sid.clear();
    intent.group_sid.clear();
    save(&path.with_extension("account-pending"), &intent).unwrap();
    fs::remove_file(&path).unwrap();
    let resumed = repair_record(&path).unwrap();
    assert_eq!(resumed.sid, account.sid);
    assert_eq!(resumed.group_sid, account.group_sid);
    assert!(!path.with_extension("account-pending").exists());
    assert!(Account::read(&path).unwrap().matches().unwrap());

    // SAFETY: Only the isolated account created by this test is removed to simulate SID drift.
    check(unsafe { NetUserDel(ptr::null(), wide(&account.name).as_ptr()) }).unwrap();
    let name = wide(&account.name);
    let password = wide(&format!("Lx9!{}", unique_id().unwrap()));
    let info = USER_INFO_1 {
        usri1_name: name.as_ptr().cast_mut(),
        usri1_password: password.as_ptr().cast_mut(),
        usri1_priv: USER_PRIV_USER,
        usri1_flags: UF_NORMAL_ACCOUNT | UF_DONT_EXPIRE_PASSWD,
        ..Default::default()
    };
    // SAFETY: The fixture replacement has a different SID and secret; repair must preserve it.
    check(unsafe { NetUserAdd(ptr::null(), 1, ptr::from_ref(&info).cast(), ptr::null_mut()) })
        .unwrap();
    let replacement = Identity {
        name: account.name.clone(),
        sid: sid_text(&sid(&account.name).unwrap()).unwrap(),
        group_sid: String::new(),
    };
    accounts.0.push(replacement.clone());
    assert_ne!(replacement.sid, account.sid);

    let repaired = repair_record(&path).unwrap();
    accounts.0.push(repaired.identity());
    assert_ne!(repaired.name, account.name);
    assert_ne!(repaired.sid, account.sid);
    assert!(repaired.matches().unwrap());
    drop(repaired.logon().unwrap());
    assert_eq!(repaired.retired.len(), 1);
    remove_identity(&repaired.retired[0]).unwrap();
    assert!(matches_sid(&replacement.name, &replacement.sid).unwrap());
    assert!(!matches_sid(&format!("{}G", account.name), &account.group_sid).unwrap());
    assert_eq!(repair_record(&path).unwrap().sid, repaired.sid);
}
