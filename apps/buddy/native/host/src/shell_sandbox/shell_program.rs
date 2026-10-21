use std::{io, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Dialect {
    Bash,
    Zsh,
    Sh,
    #[default]
    Powershell,
    Cmd,
}

impl Dialect {
    pub(super) fn validate(self, executable: &str) -> io::Result<()> {
        if !crate::windows_path::valid(executable) || executable.starts_with(r"\\") {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let name = Path::new(executable)
            .file_name()
            .ok_or(io::ErrorKind::InvalidInput)?
            .to_string_lossy()
            .to_ascii_lowercase();
        let accepted = match self {
            Self::Bash => name == "bash.exe",
            Self::Zsh => name == "zsh.exe",
            Self::Sh => name == "sh.exe",
            Self::Powershell => matches!(name.as_str(), "pwsh.exe" | "powershell.exe"),
            Self::Cmd => name == "cmd.exe",
        };
        if !accepted {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        if matches!(self, Self::Bash | Self::Zsh | Self::Sh) {
            let path = std::fs::canonicalize(executable)?;
            let root = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
            if !root.join("msys-2.0.dll").is_file()
                && !root.join("../usr/bin/msys-2.0.dll").is_file()
            {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
        }
        Ok(())
    }

    pub(super) fn extension(self) -> &'static str {
        match self {
            Self::Powershell => "ps1",
            Self::Bash | Self::Zsh | Self::Sh => "sh",
            Self::Cmd => "cmd",
        }
    }

    pub(super) fn script(self, command: &str) -> Vec<u8> {
        if self == Self::Powershell {
            format!("\u{feff}try {{ [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 }} catch {{}}\n{command}\nif (-not $?) {{ if ($LASTEXITCODE) {{ exit $LASTEXITCODE }} else {{ exit 1 }} }}\n").into_bytes()
        } else {
            command.as_bytes().to_vec()
        }
    }

    pub(super) fn command_line(
        self,
        executable: &str,
        script: &str,
        command: Option<&str>,
    ) -> io::Result<String> {
        if self == Self::Cmd {
            let command = command.ok_or(io::ErrorKind::InvalidInput)?;
            if command.is_empty() || command.contains(['\0', '\r', '\n']) {
                return Err(io::ErrorKind::InvalidInput.into());
            }
            return Ok(format!("\"{executable}\" /d /s /c \"{command}\""));
        }
        if command.is_some()
            || !crate::windows_path::valid(script)
            || script.starts_with(r"\\")
            || Path::new(script)
                .extension()
                .is_none_or(|extension| extension != self.extension())
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let flags = match self {
            Self::Powershell => "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File",
            Self::Bash => "--noprofile --norc",
            Self::Zsh => "-f",
            Self::Sh => "",
            Self::Cmd => unreachable!(),
        };
        let script = if self == Self::Powershell {
            script.to_owned()
        } else {
            script.replace('\\', "/")
        };
        Ok(format!("\"{executable}\" {flags} \"{script}\""))
    }
}

#[cfg(test)]
#[path = "../../__tests__/shell_program.rs"]
mod tests;
