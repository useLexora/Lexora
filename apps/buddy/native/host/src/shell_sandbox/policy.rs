use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};

pub(super) fn contains(root: &str, path: &str) -> bool {
    let root: Vec<u16> = root.trim_end_matches('\\').encode_utf16().collect();
    let path: Vec<u16> = path.trim_end_matches('\\').encode_utf16().collect();
    if root.len() > path.len() || (root.len() < path.len() && path[root.len()] != b'\\' as u16) {
        return false;
    }
    // SAFETY: Both slices have at least root.len() UTF-16 units; Windows ordinal comparison matches filesystem case rules.
    unsafe {
        CompareStringOrdinal(
            root.as_ptr(),
            root.len() as i32,
            path.as_ptr(),
            root.len() as i32,
            1,
        ) == CSTR_EQUAL
    }
}
