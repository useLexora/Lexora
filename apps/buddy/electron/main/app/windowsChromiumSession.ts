import type { BuddyRuntimePaths } from '../paths'
import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import process from 'node:process'
import { app } from 'electron'
import { bootstrapStep } from './desktopBootstrap'
import { prepareDesktopPrivateStorage } from './desktopStorage'

export function bindWindowsChromiumSession(legacy: BuddyRuntimePaths, paths: BuddyRuntimePaths, privateDirectoriesExecutable?: string): void {
  if (app.isReady())
    throw new Error('DESKTOP_SESSION_ALREADY_INITIALIZED')
  prepareDesktopPrivateStorage(paths.lexoraHome, privateDirectoriesExecutable)
  bootstrapStep('create_directory', () => mkdirSync(paths.sessionData, { recursive: true, mode: 0o700 }), 'session_data')
  bootstrapStep('configure_paths', () => {
    if (existsSync(join(paths.buddyHome, 'secrets'))) {
      const stableDefault = legacy.profile === 'stable' && relative(legacy.lexoraHome, join(homedir(), '.lexora')) === '' && !app.commandLine.hasSwitch('user-data-dir')
      try {
        if (inheritMissingChromiumState(paths.sessionData, [paths.userData, ...(stableDefault ? [legacy.sessionData, legacy.userData] : [])]) === 'conflict')
          process.stderr.write('DESKTOP_LEGACY_SESSION_KEY_CONFLICT\n')
      }
      catch { process.stderr.write('DESKTOP_LEGACY_SESSION_UNAVAILABLE\n') }
    }
    app.setPath('sessionData', paths.sessionData)
  }, 'session_data')
}

export function inheritMissingChromiumState(session: string, candidates: readonly string[]): 'conflict' | undefined {
  const destination = join(session, 'Local State')
  if (lstatSync(destination, { throwIfNoEntry: false }))
    return
  let selected: { content: string, key: string } | undefined
  for (const directory of candidates) {
    const source = join(directory, 'Local State')
    if (!lstatSync(source, { throwIfNoEntry: false })?.isFile())
      continue
    const content = readFileSync(source, 'utf8')
    let key: unknown
    try {
      key = JSON.parse(content)?.os_crypt?.encrypted_key
    }
    catch { continue }
    if (typeof key !== 'string' || !key)
      continue
    if (selected && selected.key !== key)
      return 'conflict'
    selected ??= { content, key }
  }
  if (selected) {
    const temporary = join(session, `.state-${randomUUID()}.tmp`)
    writeFileSync(temporary, selected.content, { flag: 'wx', mode: 0o600, flush: true })
    try {
      linkSync(temporary, destination)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error
    }
    finally { unlinkSync(temporary) }
  }
}
