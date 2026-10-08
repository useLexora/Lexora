// Shared by the name dialog and the trusted service; neither silently rewrites input.
export function validSpaceFileName(name: string, windows = true): boolean {
  if (!name || name === '.' || name === '..' || /[/\\]/u.test(name) || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    return false
  if (!windows)
    return true
  if (/[<>:"|?*]/u.test(name) || /[. ]$/u.test(name) || name.length > 255)
    return false
  const stem = name.split('.')[0]!.trimEnd().toUpperCase()
  return !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/u.test(stem)
}

export function pathInFileScope(path: string, scope: string): boolean {
  return path === scope || (scope !== '' && path.startsWith(`${scope}/`))
}
