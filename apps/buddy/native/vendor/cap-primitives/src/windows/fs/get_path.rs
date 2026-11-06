use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::{fs, io};

/// Calculates system path of `file`.
///
/// This function will automatically strip the extended prefix from the
/// resultant path to allow for joining this resultant path with relative
/// components.
pub(crate) fn get_path(file: &fs::File) -> io::Result<PathBuf> {
    // get system path to the handle
    let path = winx::file::get_file_path(file)?;

    // strip extended prefix; otherwise we will error out on any relative
    // components with `out_path`
    let wide: Vec<_> = path.as_os_str().encode_wide().collect();
    Ok(PathBuf::from(OsString::from_wide(&strip_extended_prefix(
        &wide,
    ))))
}

/// Removes the `\\?\` prefix, turning `\\?\UNC\server\share` back into
/// `\\server\share` instead of the invalid relative path `UNC\server\share`.
fn strip_extended_prefix(wide: &[u16]) -> Vec<u16> {
    let unc: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
    if let Some(rest) = wide.strip_prefix(unc.as_slice()) {
        let mut result: Vec<u16> = r"\\".encode_utf16().collect();
        result.extend_from_slice(rest);
        result
    } else if let Some(rest) = wide.strip_prefix(&['\\' as u16, '\\' as _, '?' as _, '\\' as _]) {
        rest.to_vec()
    } else {
        wide.to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::strip_extended_prefix;

    fn strip(path: &str) -> String {
        let wide: Vec<u16> = path.encode_utf16().collect();
        String::from_utf16(&strip_extended_prefix(&wide)).unwrap()
    }

    #[test]
    fn restores_unc_paths() {
        assert_eq!(
            strip(r"\\?\UNC\wsl.localhost\Ubuntu-24.04\home\user"),
            r"\\wsl.localhost\Ubuntu-24.04\home\user"
        );
    }

    #[test]
    fn strips_drive_and_keeps_plain_paths() {
        assert_eq!(strip(r"\\?\C:\Users\user"), r"C:\Users\user");
        assert_eq!(strip(r"C:\Users\user"), r"C:\Users\user");
        assert_eq!(strip(r"\\server\share\dir"), r"\\server\share\dir");
    }
}

/// Convenience function for calling `get_path` and concatenating the result
/// with `path`.
pub(super) fn concatenate(file: &fs::File, path: &Path) -> io::Result<PathBuf> {
    let file_path = get_path(file)?;
    Ok(file_path.join(path))
}
