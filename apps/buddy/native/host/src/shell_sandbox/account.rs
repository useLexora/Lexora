use std::{
    fs, io,
    os::windows::io::OwnedHandle,
    path::{Path, PathBuf},
    ptr,
};

use serde::{Deserialize, Serialize};
use windows_sys::Win32::{
    NetworkManagement::NetManagement::*,
    Security::{
        Authentication::Identity::{
            LSA_OBJECT_ATTRIBUTES, LSA_UNICODE_STRING, LsaAddAccountRights, LsaClose,
            LsaNtStatusToWinError, LsaOpenPolicy, POLICY_CREATE_ACCOUNT, POLICY_LOOKUP_NAMES,
        },
        Authorization::ConvertStringSidToSidW,
        Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN,
            CryptProtectData, CryptUnprotectData,
        },
        LOGON32_LOGON_BATCH, LOGON32_LOGON_NETWORK, LOGON32_PROVIDER_DEFAULT, LogonUserW,
        LookupAccountNameW,
    },
};

use super::security::{LocalMemory, boolean, check, owned, sid_text, unique_id, wide};
use crate::windows_security::Sid;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Account {
    pub(super) sid: String,
    password: String,
    name: String,
    pub(super) group_sid: String,
    #[serde(default)]
    retired: Vec<Identity>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    name: String,
    sid: String,
    group_sid: String,
}

fn directory() -> io::Result<PathBuf> {
    Ok(super::setup::installed_path()?
        .parent()
        .ok_or(io::ErrorKind::InvalidData)?
        .to_owned())
}

fn sid(name: &str) -> io::Result<Sid> {
    let mut sid_buffer = [0u32; 17];
    let mut sid_size = size_of_val(&sid_buffer) as u32;
    let mut domain = [0u16; 256];
    let mut domain_size = domain.len() as u32;
    let mut kind = 0;
    // SAFETY: All output buffers have their declared capacities; lookup is limited to the local account.
    boolean(unsafe {
        LookupAccountNameW(
            ptr::null(),
            wide(name).as_ptr(),
            sid_buffer.as_mut_ptr().cast(),
            &mut sid_size,
            domain.as_mut_ptr(),
            &mut domain_size,
            &mut kind,
        )
    })?;
    // SAFETY: The successful lookup initialized a valid SID in aligned storage.
    unsafe { Sid::copy(sid_buffer.as_mut_ptr().cast()) }
}

pub(super) fn parse_sid(text: &str) -> io::Result<Sid> {
    let mut pointer = ptr::null_mut();
    // SAFETY: NUL-terminated input and writable output; allocation is released after copying.
    boolean(unsafe { ConvertStringSidToSidW(wide(text).as_ptr(), &mut pointer) })?;
    let _memory = LocalMemory(pointer);
    // SAFETY: The conversion initialized this live SID.
    unsafe { Sid::copy(pointer) }
}

impl Account {
    fn read(path: &std::path::Path) -> io::Result<Self> {
        let _file = super::setup::protected_object(path)?;
        let account: Self = serde_json::from_slice(&crypt(&fs::read(path)?, false)?)?;
        if !valid_name(&account.name)
            || account
                .retired
                .iter()
                .any(|identity| !valid_name(&identity.name))
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(account)
    }

    fn matches(&self) -> io::Result<bool> {
        Ok(matches_sid(&self.name, &self.sid)?
            && matches_sid(&format!("{}G", self.name), &self.group_sid)?)
    }

    fn identity(&self) -> Identity {
        Identity {
            name: self.name.clone(),
            sid: self.sid.clone(),
            group_sid: self.group_sid.clone(),
        }
    }

    pub(super) fn logon(&self) -> io::Result<OwnedHandle> {
        self.logon_kind(LOGON32_LOGON_BATCH)
    }

    fn logon_kind(&self, kind: u32) -> io::Result<OwnedHandle> {
        let mut token = ptr::null_mut();
        // SAFETY: Credentials belong only to the provisioned unprivileged account; batch logon creates a fresh logon SID.
        boolean(unsafe {
            LogonUserW(
                wide(&self.name).as_ptr(),
                wide(".").as_ptr(),
                wide(&self.password).as_ptr(),
                kind,
                LOGON32_PROVIDER_DEFAULT,
                &mut token,
            )
        })?;
        owned(token)
    }
}

fn valid_name(name: &str) -> bool {
    name.starts_with("Lexora")
        && [18, 20].contains(&name.len())
        && name[6..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn matches_sid(name: &str, expected: &str) -> io::Result<bool> {
    if expected.is_empty() {
        return Ok(false);
    }
    match sid(name) {
        Ok(actual) => Ok(sid_text(&actual)? == expected),
        Err(error) if error.raw_os_error() == Some(1332) => Ok(false),
        Err(error) => Err(error),
    }
}

fn owner_name(owner: &Sid) -> io::Result<String> {
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(sid_text(owner)?.as_bytes()));
    Ok(format!("Lexora{}", &hash[..12]))
}

pub(super) fn owner_matches(owner: &Sid) -> io::Result<bool> {
    let path = directory()?.join(format!("{}.account", owner_name(owner)?));
    Ok(!path.exists() || Account::read(&path)?.matches()?)
}

pub(super) fn for_owner(owner: &Sid) -> io::Result<Account> {
    let key = owner_name(owner)?;
    let path = directory()?.join(format!("{key}.account"));
    let pending = directory()?.join(format!("{key}.account-pending"));
    if pending.exists() {
        return provision(&path, Account::read(&pending)?);
    }
    if path.exists() {
        let account = Account::read(&path)?;
        if !account.matches()? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Sandbox account identity requires repair",
            ));
        }
        return Ok(account);
    }
    let name = match sid(&key) {
        Err(error) if error.raw_os_error() == Some(1332) => key.clone(),
        Err(error) => return Err(error),
        Ok(_) => fresh_name()?,
    };
    provision(
        &path,
        Account {
            name,
            password: format!("Lx9!{}{}", unique_id()?, unique_id()?),
            sid: String::new(),
            group_sid: String::new(),
            retired: Vec::new(),
        },
    )
}

fn fresh_name() -> io::Result<String> {
    Ok(format!("Lexora{}", &unique_id()?.replace('-', "")[..14]))
}

fn provision(path: &Path, mut account: Account) -> io::Result<Account> {
    let pending = path.with_extension("account-pending");
    if !pending.exists() {
        save(&pending, &account)?;
    }
    let name = account.name.clone();
    let name_wide = wide(&name);
    let password_wide = wide(&account.password);
    let info = USER_INFO_1 {
        usri1_name: name_wide.as_ptr().cast_mut(),
        usri1_password: password_wide.as_ptr().cast_mut(),
        usri1_priv: USER_PRIV_USER,
        usri1_flags: UF_NORMAL_ACCOUNT | UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE,
        ..Default::default()
    };
    // SAFETY: Credentials are durable before creation. A retry adopts an existing identity only after authenticating the saved secret.
    let result =
        unsafe { NetUserAdd(ptr::null(), 1, ptr::from_ref(&info).cast(), ptr::null_mut()) };
    if result == NERR_UserExists {
        drop(
            account
                .logon()
                .or_else(|_| account.logon_kind(LOGON32_LOGON_NETWORK))?,
        );
    } else {
        check(result)?;
    }
    account.sid = sid_text(&sid(&name)?)?;
    account.group_sid = create_group(&account)?;
    deny_logons(&parse_sid(&account.sid)?)?;
    hide_account(&name, true)?;
    drop(account.logon()?);
    save(path, &account)?;
    fs::remove_file(pending)?;
    Ok(account)
}

fn save(path: &std::path::Path, account: &Account) -> io::Result<()> {
    super::acl_state::publish(path, &crypt(&serde_json::to_vec(account)?, true)?, true)
}

pub(super) fn repair() -> io::Result<()> {
    for entry in fs::read_dir(directory()?)? {
        let path = entry?.path();
        let Some(_) = path
            .file_stem()
            .and_then(|key| key.to_str())
            .filter(|key| valid_name(key) && key.len() == 18)
        else {
            continue;
        };
        if path
            .extension()
            .is_none_or(|extension| extension != "account")
        {
            continue;
        }
        let mut account = repair_record(&path)?;
        if !account.retired.is_empty() {
            let principals = account
                .retired
                .iter()
                .flat_map(|identity| [identity.sid.clone(), identity.group_sid.clone()])
                .filter(|sid| !sid.is_empty())
                .collect::<Vec<_>>();
            super::acl_state::cleanup(Some(&principals))?;
            for identity in &account.retired {
                remove_identity(identity)?;
            }
            account.retired.clear();
            save(&path, &account)?;
        }
    }
    Ok(())
}

fn repair_record(path: &Path) -> io::Result<Account> {
    let pending = path.with_extension("account-pending");
    let account = if pending.exists() {
        provision(path, Account::read(&pending)?)?
    } else {
        Account::read(path)?
    };
    if account.matches()? {
        return Ok(account);
    }
    let mut retired = account.retired.clone();
    retired.push(account.identity());
    provision(
        path,
        Account {
            name: fresh_name()?,
            password: format!("Lx9!{}{}", unique_id()?, unique_id()?),
            sid: String::new(),
            group_sid: String::new(),
            retired,
        },
    )
}

fn remove_identity(identity: &Identity) -> io::Result<()> {
    if matches_sid(&identity.name, &identity.sid)? {
        // SAFETY: The live account still has the SID recorded in administrator-protected state.
        check(unsafe { NetUserDel(ptr::null(), wide(&identity.name).as_ptr()) })?;
        hide_account(&identity.name, false)?;
    }
    let group = format!("{}G", identity.name);
    if matches_sid(&group, &identity.group_sid)? {
        // SAFETY: Only the recorded group identity is deleted; a same-named replacement is preserved.
        check(unsafe { NetLocalGroupDel(ptr::null(), wide(&group).as_ptr()) })?;
    }
    Ok(())
}

fn group_marker(account: &Account) -> io::Result<String> {
    use sha2::{Digest, Sha256};
    Ok(format!(
        "Lexora sandbox {:x}",
        Sha256::digest(account.password.as_bytes())
    ))
}

fn group_comment(name: &str) -> io::Result<String> {
    let mut buffer = ptr::null_mut();
    // SAFETY: The level-1 local group query returns a terminated description in an owned NetAPI buffer.
    check(unsafe { NetLocalGroupGetInfo(ptr::null(), wide(name).as_ptr(), 1, &mut buffer) })?;
    // SAFETY: A successful level-1 query initializes this pointer. Null descriptions are treated as empty.
    let actual = unsafe { (*buffer.cast::<LOCALGROUP_INFO_1>()).lgrpi1_comment };
    let mut text = Vec::new();
    if !actual.is_null() {
        for index in 0..256 {
            // SAFETY: The returned description is terminated; iteration stops before advancing past its terminator.
            let value = unsafe { *actual.add(index) };
            if value == 0 {
                break;
            }
            text.push(value);
        }
    }
    // SAFETY: Matching release for the NetAPI query allocation.
    unsafe { NetApiBufferFree(buffer.cast()) };
    String::from_utf16(&text).map_err(|_| io::ErrorKind::InvalidData.into())
}

fn create_group(account: &Account) -> io::Result<String> {
    let name = wide(&format!("{}G", account.name));
    let marker = group_marker(account)?;
    let comment = wide(&marker);
    let info = LOCALGROUP_INFO_1 {
        lgrpi1_name: name.as_ptr().cast_mut(),
        lgrpi1_comment: comment.as_ptr().cast_mut(),
    };
    // SAFETY: The group has a private durable provisioning marker; an unrelated group is never adopted.
    let result =
        unsafe { NetLocalGroupAdd(ptr::null(), 1, ptr::from_ref(&info).cast(), ptr::null_mut()) };
    if result == windows_sys::Win32::Foundation::ERROR_ALIAS_EXISTS || result == NERR_GroupExists {
        if marker != group_comment(&format!("{}G", account.name))? {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
    } else {
        check(result)?;
    }
    let user = parse_sid(&account.sid)?;
    let member = LOCALGROUP_MEMBERS_INFO_0 {
        lgrmi0_sid: user.as_ptr(),
    };
    // SAFETY: Only the verified sandbox account joins this dedicated group.
    let result = unsafe {
        NetLocalGroupAddMembers(
            ptr::null(),
            name.as_ptr(),
            0,
            ptr::from_ref(&member).cast(),
            1,
        )
    };
    if result != windows_sys::Win32::Foundation::ERROR_MEMBER_IN_ALIAS {
        check(result)?;
    }
    sid_text(&sid(&format!("{}G", account.name))?)
}

fn hide_account(name: &str, hide: bool) -> io::Result<()> {
    use windows_sys::Win32::System::Registry::*;
    let mut key = ptr::null_mut();
    // SAFETY: The service changes only this account's visibility in the Windows sign-in picker.
    check(unsafe {
        RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            wide(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList")
                .as_ptr(),
            0,
            ptr::null(),
            0,
            KEY_SET_VALUE,
            ptr::null(),
            &mut key,
            ptr::null_mut(),
        )
    } as u32)?;
    let value = 0u32;
    // SAFETY: The value is exactly one DWORD, or the owned account's named value is removed.
    let result = unsafe {
        if hide {
            RegSetValueExW(
                key,
                wide(name).as_ptr(),
                0,
                REG_DWORD,
                ptr::from_ref(&value).cast(),
                4,
            )
        } else {
            RegDeleteValueW(key, wide(name).as_ptr())
        }
    } as u32;
    // SAFETY: Matching close of the opened registry key.
    unsafe { RegCloseKey(key) };
    if !hide && result == 2 {
        return Ok(());
    }
    check(result)
}

pub(super) fn uninstall() -> io::Result<()> {
    for entry in fs::read_dir(directory()?)? {
        let path = entry?.path();
        let Some(_) = path
            .file_stem()
            .and_then(|key| key.to_str())
            .filter(|key| valid_name(key) && key.len() == 18)
        else {
            continue;
        };
        if path
            .extension()
            .is_none_or(|extension| extension != "account" && extension != "account-pending")
        {
            continue;
        }
        let mut account = Account::read(&path)?;
        if account.sid.is_empty() {
            match sid(&account.name) {
                Ok(actual) => {
                    drop(
                        account
                            .logon()
                            .or_else(|_| account.logon_kind(LOGON32_LOGON_NETWORK))?,
                    );
                    account.sid = sid_text(&actual)?;
                }
                Err(error) if error.raw_os_error() == Some(1332) => {}
                Err(error) => return Err(error),
            }
        }
        let group = format!("{}G", account.name);
        if account.group_sid.is_empty() {
            match sid(&group) {
                Ok(actual) if group_marker(&account)? == group_comment(&group)? => {
                    account.group_sid = sid_text(&actual)?
                }
                Ok(_) => {}
                Err(error) if error.raw_os_error() == Some(1332) => {}
                Err(error) => return Err(error),
            }
        }
        remove_identity(&account.identity())?;
        for identity in &account.retired {
            remove_identity(identity)?;
        }
        fs::remove_file(path)?;
    }
    Ok(())
}

fn crypt(data: &[u8], protect: bool) -> io::Result<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data
            .len()
            .try_into()
            .map_err(|_| io::ErrorKind::InvalidInput)?,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: DPAPI reads the live input and returns an independently allocated output; UI is disabled for service use.
    boolean(unsafe {
        if protect {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    })?;
    let _memory = LocalMemory(output.pbData.cast());
    // SAFETY: The successful DPAPI call returned exactly cbData readable bytes.
    Ok(unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec())
}

fn deny_logons(sid: &Sid) -> io::Result<()> {
    let attributes = LSA_OBJECT_ATTRIBUTES {
        Length: size_of::<LSA_OBJECT_ATTRIBUTES>() as u32,
        ..Default::default()
    };
    let mut handle = 0isize;
    // SAFETY: Local policy is opened only during elevated setup; output receives an owned policy handle.
    check(unsafe {
        LsaNtStatusToWinError(LsaOpenPolicy(
            ptr::null(),
            &attributes,
            (POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES) as u32,
            &mut handle,
        ))
    })?;
    let rights: Vec<Vec<u16>> = [
        "SeBatchLogonRight",
        "SeDenyInteractiveLogonRight",
        "SeDenyRemoteInteractiveLogonRight",
        "SeDenyNetworkLogonRight",
    ]
    .iter()
    .map(|text| wide(text))
    .collect();
    let rights: Vec<LSA_UNICODE_STRING> = rights
        .iter()
        .map(|text| LSA_UNICODE_STRING {
            Length: ((text.len() - 1) * 2) as u16,
            MaximumLength: (text.len() * 2) as u16,
            Buffer: text.as_ptr().cast_mut(),
        })
        .collect();
    // SAFETY: Rights and SID remain live for the call; the handle is closed regardless of the result.
    let result = unsafe {
        LsaNtStatusToWinError(LsaAddAccountRights(
            handle,
            sid.as_ptr(),
            rights.as_ptr(),
            rights.len() as u32,
        ))
    };
    // SAFETY: Matching close of the policy handle opened above.
    unsafe { LsaClose(handle) };
    check(result)
}

#[cfg(test)]
#[path = "../../__tests__/shell_sandbox_account.rs"]
mod tests;
