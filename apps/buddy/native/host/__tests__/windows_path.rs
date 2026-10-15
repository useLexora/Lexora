use super::{valid, valid_component};

#[test]
fn components_reject_devices_controls_and_utf16_overflow() {
    for name in [
        "",
        ".",
        "..",
        "CON",
        "con.txt",
        "NUL .txt",
        "COM¹",
        "LPT².log",
        "COM³.txt",
        "CONIN$",
        "file:stream",
        "a/b",
        "a\\b",
        "trailing.",
        "trailing ",
    ] {
        assert!(!valid_component(name), "{name:?}");
    }
    for code in 0..32 {
        assert!(!valid_component(&format!("file{}.txt", char::from(code))));
    }
    assert!(valid_component(&"📝".repeat(127)));
    assert!(!valid_component(&"📝".repeat(128)));
    assert!(valid_component(&"a".repeat(255)));
    assert!(!valid_component(&"a".repeat(256)));
    for name in ["COM10.txt", "conifer.txt", "操作📝.md", "COM1 notes.txt"] {
        assert!(valid_component(name), "{name:?}");
    }
    assert!(valid(r"C:\"));
    assert!(valid(r"\\server\share\操作📝.md"));
    assert!(!valid(r"C:\directory\COM¹.txt"));
}
