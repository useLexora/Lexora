use std::{
    io::{self, Read, Write},
    os::windows::io::AsRawHandle,
    ptr, slice, str,
};

use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    },
    Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType},
};
use zeroize::{Zeroize, Zeroizing};

const ENTROPY: &[u8] = b"uselexora.app/LexoraBuddy/provider-credential/DPAPI/current-user/v1";
const MAGIC: &[u8; 5] = b"LXPC\x01";
const HEADER: usize = 10;
const SEAL: u8 = 1;
const OPEN: u8 = 2;
const RESPONSE: u8 = 0x80;
const MAX_TEXT: usize = 1024 * 1024;
const MAX_BLOB: usize = MAX_TEXT + 64 * 1024;

pub(super) fn run() -> Result<(), ()> {
    let (stdin, stdout) = (io::stdin(), io::stdout());
    // SAFETY: the standard streams own these borrowed handles across both queries.
    if unsafe {
        GetFileType(stdin.as_raw_handle()) != FILE_TYPE_PIPE
            || GetFileType(stdout.as_raw_handle()) != FILE_TYPE_PIPE
    } {
        return Err(());
    }
    process(stdin.lock(), stdout.lock())
}

fn process(mut input: impl Read, mut output: impl Write) -> Result<(), ()> {
    let mut header = [0; HEADER];
    input.read_exact(&mut header).map_err(|_| ())?;
    let (op, len) = request(&header)?;
    let mut frame = Zeroizing::new(vec![0; HEADER + len]);
    frame[..HEADER].copy_from_slice(&header);
    input.read_exact(&mut frame[HEADER..]).map_err(|_| ())?;
    if input.read(&mut [0]).map_err(|_| ())? != 0 {
        return Err(());
    }
    let result = match op {
        SEAL => {
            // Authenticate the complete versioned seal frame, not just arbitrary cleartext.
            seal_payload(&frame)?;
            dpapi(SEAL, &frame)?
        }
        OPEN => dpapi(OPEN, &frame[HEADER..])?,
        _ => return Err(()),
    };
    let bytes = result.bytes();
    let payload = if op == OPEN {
        seal_payload(bytes)?
    } else {
        bytes
    };
    header[5] = op | RESPONSE;
    header[6..].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    output
        .write_all(&header)
        .and_then(|()| output.write_all(payload))
        .and_then(|()| output.flush())
        .map_err(|_| ())
}

fn request(header: &[u8; HEADER]) -> Result<(u8, usize), ()> {
    if &header[..5] != MAGIC {
        return Err(());
    }
    let len = u32::from_le_bytes(header[6..].try_into().map_err(|_| ())?) as usize;
    match header[5] {
        SEAL if len <= MAX_TEXT => Ok((SEAL, len)),
        OPEN if (1..=MAX_BLOB).contains(&len) => Ok((OPEN, len)),
        _ => Err(()),
    }
}

fn seal_payload(frame: &[u8]) -> Result<&[u8], ()> {
    let (header, payload) = frame.split_first_chunk::<HEADER>().ok_or(())?;
    if request(header)? != (SEAL, payload.len()) || str::from_utf8(payload).is_err() {
        return Err(());
    }
    Ok(payload)
}

struct LocalBlob(CRYPT_INTEGER_BLOB);

impl LocalBlob {
    fn bytes(&self) -> &[u8] {
        // SAFETY: only constructed from a successful DPAPI call with a non-null owned allocation.
        unsafe { slice::from_raw_parts(self.0.pbData, self.0.cbData as usize) }
    }
}

impl Drop for LocalBlob {
    fn drop(&mut self) {
        // SAFETY: DPAPI transferred ownership of cbData writable bytes allocated with LocalAlloc.
        unsafe {
            slice::from_raw_parts_mut(self.0.pbData, self.0.cbData as usize).zeroize();
            LocalFree(self.0.pbData.cast());
        }
    }
}

fn dpapi(op: u8, data: &[u8]) -> Result<LocalBlob, ()> {
    let blob = |bytes: &[u8]| CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let (source, entropy) = (blob(data), blob(ENTROPY));
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: both input blobs borrow bounded initialized data for the call (Win32 treats
    // them as read-only). No prompt, description output, machine scope or caller-supplied entropy.
    let success = unsafe {
        match op {
            SEAL => CryptProtectData(
                &source,
                ptr::null(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            ),
            OPEN => CryptUnprotectData(
                &source,
                ptr::null_mut(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            ),
            _ => return Err(()),
        }
    };
    if success == 0 || output.pbData.is_null() {
        return Err(());
    }
    let result = LocalBlob(output);
    let limit = if op == OPEN {
        HEADER + MAX_TEXT
    } else {
        MAX_BLOB
    };
    if !(1..=limit).contains(&(result.0.cbData as usize)) {
        return Err(());
    }
    Ok(result)
}

#[cfg(test)]
#[path = "../../../__tests__/provider_credential.rs"]
mod tests;
