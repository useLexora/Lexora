pub(crate) fn valid(path: &str) -> bool {
    let bytes = path.as_bytes();
    if path.encode_utf16().count() > 32767
        || path.starts_with("\\\\?\\")
        || path.starts_with("\\\\.\\")
    {
        return false;
    }
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":\\";
    let components = if drive {
        &path[3..]
    } else if let Some(unc) = path.strip_prefix("\\\\") {
        if unc
            .split('\\')
            .take(2)
            .filter(|part| !part.is_empty())
            .count()
            != 2
        {
            return false;
        }
        unc
    } else {
        return false;
    };
    components
        .split('\\')
        .all(|component| component.is_empty() || valid_component(component))
}

pub(crate) fn valid_component(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_uppercase();
    let device = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    !component.is_empty()
        && component.encode_utf16().count() <= 255
        && !device
        && !component.ends_with(['.', ' '])
        && !component
            .chars()
            .any(|c| c < ' ' || "<>:\"|?*/\\".contains(c))
}

#[cfg(test)]
#[path = "../__tests__/windows_path.rs"]
mod tests;
