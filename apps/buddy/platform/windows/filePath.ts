import { win32 } from 'node:path'
import { validFileName } from '../../shared/files/fileName'

export function validateWindowsFilePath(path: string): string {
  const input = path.replaceAll('/', '\\')
  if (/^(?:\\\\[?.]\\|\\\?\?\\)/.test(input))
    throw new Error('Windows device paths are not file inputs')
  const drivePath = /^[a-z]:\\/i.test(input)
  if (!drivePath && !/^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(input))
    throw new Error('Windows file paths must be fully qualified')
  const segments = input.slice(drivePath ? 3 : 2).split('\\')
  for (const [index, segment] of segments.entries()) {
    if ((drivePath || index >= 2) && (segment === '.' || segment === '..'))
      continue
    if (segment && !validFileName(segment, 'win32')) {
      throw new Error('Windows file path contains an unsupported stream or device name')
    }
  }
  return win32.normalize(input).replace(/^[a-z]:/i, drive => drive.toUpperCase())
}

export function resolveWindowsFilePath(path: string, cwd?: string): string {
  if (!path.trim())
    throw new Error('Windows file paths cannot be empty')
  if (!cwd || /^[a-z]:|^[\\/]/i.test(path))
    return validateWindowsFilePath(path)
  return validateWindowsFilePath(`${validateWindowsFilePath(cwd)}\\${path}`)
}
