import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { extensionIdSchema } from '../../shared/extensions/extensionManifest'
import { ensureWindowsPrivateDirectories, PrivateDirectoryError } from '../windows/privateDirectories'
import { withExtensionLaunchStorage } from './extensionLaunchStorage'

export interface ExtensionLaunchLocation { dataRoot: string, privateDirectoriesExecutable?: string }
const machine = createHash('sha256').update(hostname()).digest('hex').slice(0, 16)
const ownership = new RegExp(`^${machine}-([1-9]\\d*)-(preparing|[1-9]\\d*)$`)
const launchId = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/

function gone(pid: string): boolean {
  try {
    process.kill(Number(pid), 0)
  }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
  return false
}

export function windowsLaunchDirectoryFailure(cause: unknown) {
  if (!(cause instanceof PrivateDirectoryError) || cause.failure.operation !== 'open_directory')
    return cause
  const error = cause.failure.systemError
  if (!error)
    return cause
  const diskFull = error.domain === 'ntstatus' ? error.code === 0xC000007F : [39, 112].includes(error.code)
  const diskQuota = error.domain === 'ntstatus' ? error.code === 0xC0000802 : error.code === 1295
  return diskFull || diskQuota ? Object.assign(new Error('Private directory allocation failed', { cause }), { code: diskFull ? 'ENOSPC' : 'EDQUOT' }) : cause
}

async function ensureWindowsDirectory(path: string, executable?: string) {
  try {
    await ensureWindowsPrivateDirectories([path], executable)
  }
  catch (cause) { throw windowsLaunchDirectoryFailure(cause) }
}

async function reapInactive(root: string) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !launchId.test(entry.name))
      continue
    const directory = join(root, entry.name)
    const receipt = join(directory, '.owner')
    try {
      if (!(await lstat(receipt)).isDirectory())
        continue
      const files = await readdir(receipt, { withFileTypes: true })
      const file = files.length === 1 && files[0]!.isFile() ? files[0] : undefined
      const match = file && ownership.exec(file.name)
      if (!match || !gone(match[1]!) || (match[2] !== 'preparing' && !gone(match[2]!)))
        continue
      // A preparing owner could have spawned between readdir and the host PID check.
      if ((await lstat(join(receipt, file.name))).isFile())
        await rm(directory, { recursive: true, force: true })
    }
    catch { /* Unreadable or changing ownership is not evidence of inactivity. */ }
  }
}

export async function createExtensionLaunchDirectory({ dataRoot, privateDirectoriesExecutable }: ExtensionLaunchLocation, extensionId: string) {
  if (!isAbsolute(dataRoot))
    throw new Error('EXTENSION_LAUNCH_ROOT_UNAVAILABLE')
  const segments = ['cache', 'extensions', extensionIdSchema.parse(extensionId), 'launches']
  const root = join(dataRoot, ...segments)
  const location = ['<profile>', ...segments].join('/')
  const write = <T>(operation: () => Promise<T>) => withExtensionLaunchStorage(location, operation)
  const directory = join(root, randomUUID())
  if (process.platform === 'win32') {
    await write(() => ensureWindowsDirectory(root, privateDirectoriesExecutable))
  }
  else {
    let path = dataRoot
    for (const segment of segments) {
      path = join(path, segment)
      try {
        await write(() => mkdir(path, { mode: 0o700 }))
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(path)).isDirectory())
          throw error
      }
    }
  }
  await reapInactive(root)
  if (process.platform === 'win32') {
    // The native helper preserves an existing directory; only claim a fresh UUID.
    const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        throw error
      return null
    })
    if (existing)
      throw new Error('EXTENSION_LAUNCH_DIRECTORY_EXISTS')
    await write(() => ensureWindowsDirectory(directory, privateDirectoriesExecutable))
  }
  else {
    await write(() => mkdir(directory, { mode: 0o700 }))
  }
  const receipt = join(directory, '.owner')
  const prefix = join(receipt, `${machine}-${process.pid}-`)
  let marker = `${prefix}preparing`
  try {
    await write(async () => {
      await mkdir(receipt, { mode: 0o700 })
      await writeFile(marker, '', { flag: 'wx', mode: 0o600 })
    })
  }
  catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  let updating = Promise.resolve()
  const transition = (state: string) => {
    const next = prefix + state
    updating = write(() => rename(marker, next)).then(() => {
      marker = next
    })
    return updating
  }
  return {
    directory,
    write,
    // No PID is known across the spawn boundary. Never reap a pending receipt.
    beforeSpawn: () => transition('pending'),
    spawned: (pid: number | undefined) => pid ? transition(String(pid)) : Promise.resolve(),
    dispose: async () => {
      await updating.catch(() => {})
      await rm(directory, { recursive: true, force: true })
    },
  }
}
