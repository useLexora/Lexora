import type { BuddyPlatformId } from '../../shared/platform'
import { mkdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { parse, resolve } from 'node:path'
import { OPERATING_SYSTEM } from '../../shared/platform/identifiers'
import { currentPlatform } from '../currentPlatform'
import { validateWindowsFilePath } from '../windows/filePath'
import { ensureWindowsPrivateDirectories, ensureWindowsPrivateDirectoriesSync } from '../windows/privateDirectories'

const adapters: Record<BuddyPlatformId, (paths: string[], executable?: string) => Promise<void>> = {
  linux: ensurePosixPrivateDirectories,
  darwin: ensurePosixPrivateDirectories,
  win32: ensureWindowsPrivateDirectories,
}

async function ensurePosixPrivateDirectories(paths: string[]): Promise<void> {
  await Promise.all(paths.map(path => mkdir(path, { recursive: true, mode: 0o700 })))
}

function privateDirectoryPaths(paths: readonly string[]): string[] {
  const windows = currentPlatform.id === OPERATING_SYSTEM.Windows
  const directories = [...new Set(paths.map(path => windows ? validateWindowsFilePath(path) : resolve(path)))]
  const samePath = (left: string, right: string) => windows ? left.toLowerCase() === right.toLowerCase() : left === right
  if (directories.some(path => samePath(path, parse(path).root) || samePath(path, homedir())))
    throw new Error('Buddy private storage must use an application directory')
  return directories
}

export async function ensurePrivateDirectories(paths: readonly string[], windowsExecutable?: string): Promise<void> {
  const directories = privateDirectoryPaths(paths)
  if (directories.length)
    await adapters[currentPlatform.id](directories, windowsExecutable)
}

export function ensurePrivateDirectoriesSync(paths: readonly string[], windowsExecutable?: string): void {
  const directories = privateDirectoryPaths(paths)
  if (!directories.length)
    return
  if (currentPlatform.id === OPERATING_SYSTEM.Windows) {
    ensureWindowsPrivateDirectoriesSync(directories, windowsExecutable)
    return
  }
  for (const directory of directories)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
}
