import type { PrivateDirectoryFailure } from '../../../shared/diagnostics/privateDirectoryFailure'
import type { BuddyRuntimePaths } from '../paths'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ensurePrivateDirectories, ensurePrivateDirectoriesSync } from '../../../platform/filesystem/privateDirectories'
import { PrivateDirectoryError } from '../../../platform/windows/privateDirectories'
import { DesktopBootstrapError } from './desktopBootstrap'

type DirectoryRole = NonNullable<PrivateDirectoryFailure['directoryRole']>

export function prepareDesktopPrivateStorage(directory: string, executable?: string): void {
  try {
    ensurePrivateDirectoriesSync([directory], executable)
  }
  catch (error) {
    throw privateStorageFailure(error)
  }
}

export async function checkDesktopDirectories(directories: Partial<Record<DirectoryRole, string>>, executable?: string): Promise<void> {
  if (directories.lexora_home) {
    try {
      await ensurePrivateDirectories([directories.lexora_home], executable)
    }
    catch (error) {
      throw privateStorageFailure(error)
    }
  }
  const entries = Object.entries(directories) as [DirectoryRole, string][]
  const unique = entries.filter(([, path], index) => entries.findIndex(([, candidate]) => candidate === path) === index)
  for (const [role, directory] of unique) {
    if (directory !== directories.lexora_home) {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
      }
      catch (error) {
        throw new DesktopBootstrapError({ kind: 'desktop_bootstrap', operation: 'create_directory', directoryRole: role }, error)
      }
    }
    try {
      await probeDirectory(directory)
    }
    catch (error) {
      throw new DesktopBootstrapError({ kind: 'desktop_bootstrap', operation: 'probe_directory', directoryRole: role }, error)
    }
  }
}

function privateStorageFailure(error: unknown): Error {
  if (error instanceof PrivateDirectoryError) {
    error.failure.directoryRole = 'lexora_home'
    return error
  }
  return new DesktopBootstrapError({ kind: 'desktop_bootstrap', operation: 'create_directory', directoryRole: 'lexora_home' }, error)
}

export function criticalDesktopDirectories(paths: BuddyRuntimePaths) {
  return { lexora_home: paths.lexoraHome, user_data: paths.userData, session_data: paths.sessionData } as const
}

async function probeDirectory(directory: string): Promise<void> {
  const source = join(directory, `.lexora-startup-${randomUUID()}.tmp`)
  const target = `${source}.renamed`
  const handle = await open(source, 'wx', 0o600)
  let current = source
  try {
    try {
      await handle.writeFile('Lexora startup check', 'utf8')
      await handle.sync()
    }
    finally {
      await handle.close()
    }
    if (await readFile(source, 'utf8') !== 'Lexora startup check')
      throw Object.assign(new Error('Directory probe could not be verified'), { code: 'EIO' })
    await rename(source, target)
    current = target
  }
  finally {
    await rm(current)
  }
}
