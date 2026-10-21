use super::Dialect;

#[test]
fn dialect_uses_matching_flags_and_preserves_script_paths() {
    let script = r"C:\private folder\command.sh";
    assert_eq!(
        Dialect::Bash
            .command_line(r"C:\Git\bin\bash.exe", script, None)
            .unwrap(),
        r#""C:\Git\bin\bash.exe" --noprofile --norc "C:/private folder/command.sh""#
    );
    assert!(
        Dialect::Powershell
            .command_line(r"C:\pwsh.exe", script, None)
            .is_err()
    );
    assert_eq!(Dialect::Sh.script("printf 'a\nb'"), b"printf 'a\nb'");
}

#[test]
fn cmd_keeps_quotes_literal_and_rejects_multiline() {
    assert_eq!(
        Dialect::Cmd
            .command_line(
                r"C:\Windows\System32\cmd.exe",
                "",
                Some(r#"echo "hello" & echo done"#)
            )
            .unwrap(),
        r#""C:\Windows\System32\cmd.exe" /d /s /c "echo "hello" & echo done""#
    );
    assert!(
        Dialect::Cmd
            .command_line(
                r"C:\Windows\System32\cmd.exe",
                "",
                Some("echo one\necho two")
            )
            .is_err()
    );
}

#[test]
fn legacy_dialect_defaults_to_powershell_and_preserves_utf8_bom() {
    let script = Dialect::default().script("Write-Output '你好'");
    assert!(script.starts_with(&[0xef, 0xbb, 0xbf]));
    assert!(
        String::from_utf8(script)
            .unwrap()
            .contains("Write-Output '你好'")
    );
}
