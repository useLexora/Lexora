use std::io;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Evidence {
    source: String,
    version: u32,
    architecture: String,
    build: u32,
    sequence: u32,
    uptime_millis: String,
}

impl Evidence {
    pub(super) fn valid(&self) -> bool {
        self.source == "windows-boot-sequence"
            && self.version == 1
            && self.architecture == "x64"
            && supported_build(self.build)
            && self.sequence != 0
            && self.uptime_millis.parse::<u64>().is_ok()
    }

    pub(super) fn proves_restart_from(&self, previous: &Self) -> bool {
        self.valid()
            && previous.valid()
            && self.architecture == previous.architecture
            && self.build == previous.build
            && self.sequence != previous.sequence
            && self.uptime_millis.parse::<u64>().ok() < previous.uptime_millis.parse::<u64>().ok()
    }
}

fn supported_build(build: u32) -> bool {
    build == 26100
}

#[cfg(all(windows, target_arch = "x86_64"))]
pub(crate) fn capture() -> io::Result<Evidence> {
    use windows_sys::Win32::System::{
        Diagnostics::Debug::ReadProcessMemory, SystemInformation::GetTickCount64,
        Threading::GetCurrentProcess,
    };

    fn read() -> io::Result<(u32, u32)> {
        let mut bytes = [0u8; 0x2c8];
        let mut copied = 0;
        // SAFETY: ReadProcessMemory validates the fixed x64 shared-page mapping. No untrusted pointer is dereferenced.
        let result = unsafe {
            ReadProcessMemory(
                GetCurrentProcess(),
                0x7ffe0000usize as *const _,
                bytes.as_mut_ptr().cast(),
                bytes.len(),
                &mut copied,
            )
        };
        if result == 0 || copied != bytes.len() {
            return Err(io::Error::last_os_error());
        }
        decode(&bytes)
    }

    let (build, sequence) = read()?;
    // SAFETY: This public query returns kernel uptime, not adjustable wall-clock time.
    let uptime_millis = unsafe { GetTickCount64() }.to_string();
    if read()? != (build, sequence) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(Evidence {
        source: "windows-boot-sequence".into(),
        version: 1,
        architecture: "x64".into(),
        build,
        sequence,
        uptime_millis,
    })
}

#[cfg(all(windows, not(target_arch = "x86_64")))]
pub(crate) fn capture() -> io::Result<Evidence> {
    Err(io::ErrorKind::Unsupported.into())
}

#[cfg(any(target_arch = "x86_64", test))]
fn decode(bytes: &[u8; 0x2c8]) -> io::Result<(u32, u32)> {
    let word = |offset: usize| {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap_or_default())
    };
    let build = word(0x260);
    let sequence = word(0x2c4);
    if word(0x26c) != 10 || word(0x270) != 0 || !supported_build(build) || sequence == 0 {
        return Err(io::ErrorKind::Unsupported.into());
    }
    Ok((build, sequence))
}

#[cfg(test)]
#[path = "../../../__tests__/windows_boot.rs"]
mod tests;
