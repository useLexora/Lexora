import type { BuddyPlatformId } from '../../shared/platform'
import { posix, win32 } from 'node:path'
import { currentPlatform } from '../currentPlatform'
import { resolveWindowsFilePath } from '../windows/filePath'

interface FilePathAdapter {
  path: typeof posix
  resolveInput: (input: string, cwd?: string) => string
  sensitiveKey: (path: string) => string
}

export const filePathAdapters: Record<BuddyPlatformId, FilePathAdapter> = {
  linux: { path: posix, resolveInput: resolvePosixFilePath, sensitiveKey: path => path },
  darwin: { path: posix, resolveInput: resolvePosixFilePath, sensitiveKey: path => path },
  win32: { path: win32, resolveInput: resolveWindowsFilePath, sensitiveKey: path => path.toLowerCase() },
}

export const filePaths = filePathAdapters[currentPlatform.id]

export function containsCanonicalPath(root: string, candidate: string): boolean {
  return relativeCanonicalPath(root, candidate) !== null
}

export function relativeCanonicalPath(root: string, candidate: string): string | null {
  try {
    const parent = filePaths.resolveInput(root)
    const child = filePaths.resolveInput(candidate)
    const prefix = parent.endsWith(filePaths.path.sep) ? parent : `${parent}${filePaths.path.sep}`
    if (child === parent)
      return ''
    return child.startsWith(prefix) ? child.slice(prefix.length) : null
  }
  catch {
    return null
  }
}

function resolvePosixFilePath(input: string, cwd?: string): string {
  if (!input.trim() || input.includes('\0'))
    throw new Error('File paths must be nonempty and contain no NUL')
  if (posix.isAbsolute(input))
    return posix.normalize(input)
  if (!cwd || !posix.isAbsolute(cwd) || cwd.includes('\0'))
    throw new Error('Relative file paths require an absolute working directory')
  return posix.resolve(cwd, input)
}
