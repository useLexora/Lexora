export function validFileName(name: string, platform: string): boolean {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name))
    return false
  if (platform !== 'win32')
    return true
  const stem = name.split('.')[0]!.replace(/ +$/, '')
  return name.length <= 255
    && !/[<>:"|?*]/.test(name)
    && ![...name].some(character => character.charCodeAt(0) < 32)
    && !/[. ]$/.test(name)
    && !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(stem)
}
