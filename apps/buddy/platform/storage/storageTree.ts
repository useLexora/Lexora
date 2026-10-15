import type { StorageProgress, StorageUsage, StorageUsageCategoryId, StorageUsageDetailId } from '../../shared/storage/storageApi'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, readlink, statfs, symlink, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { storageUsageDetails } from '../../shared/storage/storageApi'
import { ensurePrivateDirectories } from '../filesystem/privateDirectories'
import { chromiumCacheEntry, chromiumTransientEntry } from './storageCopyPolicy'
import { containsStoragePath, isMissing, storageError, syncStorageDirectory } from './storageFiles'

export interface StorageEntry {
  path: string
  size: number
  link: string | null
  mtimeMs: number
  directory: boolean
  executable: boolean
}
export type StorageReporter = (progress: StorageProgress) => void
export interface StorageCopyPlan {
  entries: StorageEntry[]
  totalBytes: number
}
export async function* walkStorage(root: string, exclude: (path: string) => boolean = () => false, prefix = ''): AsyncGenerator<StorageEntry> {
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name
    if (exclude(path))
      continue
    const absolute = join(root, path)
    const metadata = await lstat(absolute)
    if (metadata.isSymbolicLink()) {
      yield { path, size: 0, link: await readlink(absolute), mtimeMs: metadata.mtimeMs, directory: false, executable: false }
    }
    else if (metadata.isDirectory()) {
      yield { path, size: 0, link: null, mtimeMs: metadata.mtimeMs, directory: true, executable: false }
      yield* walkStorage(root, exclude, path)
    }
    else if (metadata.isFile()) {
      yield { path, size: metadata.size, link: null, mtimeMs: metadata.mtimeMs, directory: false, executable: !!(metadata.mode & 0o111) }
    }
    else {
      throw storageError('STORAGE_SPECIAL_FILE')
    }
  }
}
export function storageTransient(path: string): boolean {
  const browserEntry = /^(?:device\/(?:electron|chromium)|\.runtime\/(?:electron|cache\/chromium))\/([^/]+)$/.exec(path)?.[1]
  return (browserEntry !== undefined && chromiumTransientEntry(browserEntry))
    || /^\.storage-[a-f0-9-]{36}$/.test(path)
    || path === '.storage-retired.json'
    || path === '.runtime/browser-adapter.sock' || path === '.runtime/native-pet.sock'
}
export async function hashStorageFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk)
  return hash.digest('hex')
}
export async function planStorageCopy(source: string, options: {
  signal: AbortSignal
  report: StorageReporter
  exclude?: (path: string) => boolean
}): Promise<StorageCopyPlan> {
  const entries: StorageEntry[] = []
  let totalBytes = 0
  for await (const entry of walkStorage(source, path => storageTransient(path) || !!options.exclude?.(path))) {
    options.signal.throwIfAborted()
    entries.push(entry)
    totalBytes += entry.size
    if (entries.length % 128 === 0)
      options.report({ phase: 'preparing', completedBytes: 0, totalBytes: null, files: entries.length, error: null })
  }
  return { entries, totalBytes }
}
export async function copyStorageTree(source: string, target: string, options: {
  signal: AbortSignal
  report: StorageReporter
  exclude?: (path: string) => boolean
  destinationRoot?: string
  privateDirectoriesExecutable?: string
  plan?: StorageCopyPlan
  overwrite?: boolean
}): Promise<void> {
  const { entries, totalBytes } = options.plan ?? await planStorageCopy(source, options)
  await ensurePrivateDirectories([target], options.privateDirectoriesExecutable)
  const disk = await statfs(target)
  if (disk.bavail * disk.bsize < totalBytes * 1.1 + 16 * 1024 * 1024)
    throw storageError('STORAGE_NO_SPACE')
  let completedBytes = 0
  let files = 0
  let lastReport = 0
  for (const entry of entries) {
    options.signal.throwIfAborted()
    const from = join(source, entry.path)
    const to = join(target, entry.path)
    const previous = options.overwrite
      ? await lstat(to).catch((error) => {
          if (isMissing(error))
            return null
          throw error
        })
      : null
    if (previous?.isSymbolicLink())
      await unlink(to)
    if (entry.directory) {
      await mkdir(to, { recursive: true, mode: 0o700 })
      continue
    }
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    if (entry.link !== null) {
      const mapped = isAbsolute(entry.link) && containsStoragePath(source, entry.link)
        ? join(options.destinationRoot ?? target, relative(source, entry.link))
        : entry.link
      await symlink(mapped, to)
    }
    else {
      const before = await lstat(from)
      if (!before.isFile() || before.size !== entry.size || before.mtimeMs !== entry.mtimeMs)
        throw storageError('STORAGE_SOURCE_CHANGED')
      const input = await open(from, 'r')
      const output = await open(to, options.overwrite ? 'w' : 'wx', before.mode & 0o777)
      const expected = createHash('sha256')
      try {
        const opened = await input.stat()
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs)
          throw storageError('STORAGE_SOURCE_CHANGED')
        const buffer = new Uint8Array(1024 * 1024)
        while (true) {
          options.signal.throwIfAborted()
          const { bytesRead } = await input.read(buffer)
          if (!bytesRead)
            break
          const bytes = buffer.subarray(0, bytesRead)
          expected.update(bytes)
          let written = 0
          while (written < bytesRead) {
            const result = await output.write(bytes.subarray(written))
            if (!result.bytesWritten)
              throw storageError('STORAGE_WRITE_FAILED')
            written += result.bytesWritten
          }
          completedBytes += bytesRead
          if (Date.now() - lastReport >= 100) {
            options.report({ phase: 'copying', completedBytes, totalBytes, files, error: null })
            lastReport = Date.now()
          }
        }
        if (options.overwrite)
          await output.chmod(before.mode & 0o777)
        await output.sync()
        const after = await input.stat()
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
          throw storageError('STORAGE_SOURCE_CHANGED')
      }
      finally {
        await Promise.all([input.close(), output.close()])
      }
      if (await hashStorageFile(to, options.signal) !== expected.digest('hex'))
        throw storageError('STORAGE_COPY_INVALID')
    }
    files++
  }
  for (const entry of entries.filter(entry => entry.directory).reverse())
    await syncStorageDirectory(join(target, entry.path))
  await syncStorageDirectory(target)
  options.report({ phase: 'copying', completedBytes, totalBytes, files, error: null })
}
function storageUsageCategory(path: string): [StorageUsageCategoryId, StorageUsageDetailId | null] {
  const browserEntry = /^(?:device\/(?:electron|chromium)|\.runtime\/(?:electron|cache\/chromium))\/(?:Partitions\/[^/]+\/)?([^/]+)(?:\/|$)/.exec(path)?.[1]
  if (browserEntry && chromiumCacheEntry(browserEntry)) {
    const category = /\/Partitions\//.test(path) ? 'browser' : 'cache'
    return [category, browserEntry === 'Cache' ? 'webCache' : browserEntry === 'Code Cache' ? 'codeCache' : 'graphicsCache']
  }
  if ((browserEntry && /^(?:Crashpad|Crash Reports)$/.test(browserEntry)) || /^(?:device\/crashes|(?:device|\.runtime)\/state\/crashes)\//.test(path))
    return ['logs', 'crashes']
  if (/^(?:logs|(?:device|\.runtime)\/state\/logs)\//.test(path))
    return ['logs', 'application']
  if (/^buddy\/(?:skills|agent\/skills|spaces\/[^/]+\/skills)\//.test(path))
    return ['skills', null]
  if (path.startsWith('buddy/extensions/')) {
    const entry = path.split('/')[2]
    return ['plugins', entry === 'packages' ? 'packages' : entry === 'data' ? 'pluginData' : 'configuration']
  }
  if (browserEntry)
    return ['browser', 'siteData']
  if (path === 'config.toml' || /^buddy\/workbench(?:\.previous)?\.json$/.test(path))
    return ['device', null]
  const first = path.split('/')[0]
  if (first === 'recovery')
    return ['exports', 'recovery']
  if (first === 'exports')
    return ['exports', path.startsWith('exports/snapshots/') ? 'snapshots' : 'other']
  if (first === 'cache')
    return ['cache', 'other']
  if (first === 'device' || first === '.runtime' || path.startsWith('buddy/secrets/'))
    return ['device', null]
  if (/^buddy\/buddy\.sqlite3(?:-(?:wal|shm|journal))?$/.test(path))
    return ['data', 'database']
  if (/^buddy\/(?:conversations|spaces)\/[^/]+\/workspace\//.test(path) || /^buddy\/conversations\/[^/]+\/artifacts\//.test(path))
    return ['data', 'workspace']
  if (/^buddy\/(?:conversations\/[^/]+\/(?:inputs|image-inputs|media)|drafts\/[^/]+\/attachments)\//.test(path))
    return ['data', 'attachments']
  if (/^buddy\/conversations\/[^/]+\/(?:session|events)\//.test(path))
    return ['data', 'sessions']
  if (/^buddy\/conversations\/[^/]+\/changes\//.test(path))
    return ['data', 'changes']
  return ['data', 'other']
}
export async function measureStorage(root: string): Promise<StorageUsage> {
  const categories: StorageUsage['categories'] = (Object.keys(storageUsageDetails) as StorageUsageCategoryId[]).map(id => ({
    id,
    bytes: 0,
    files: 0,
    details: storageUsageDetails[id].map(detail => ({ id: detail, bytes: 0, files: 0 })),
  }))
  let missing = 0
  try {
    for await (const entry of walkStorage(root, storageTransient)) {
      if (entry.directory)
        continue
      const [id, detailId] = storageUsageCategory(entry.path)
      const category = categories.find(item => item.id === id)!
      category.bytes += entry.size
      category.files++
      if (detailId) {
        const detail = category.details.find(item => item.id === detailId)!
        detail.bytes += entry.size
        detail.files++
      }
    }
  }
  catch (error) {
    if (!isMissing(error))
      throw error
    missing++
  }
  return { categories, scannedAt: new Date().toISOString(), missing }
}
export async function syncStorageDirectories(root: string): Promise<void> {
  const directories: string[] = [root]
  for await (const entry of walkStorage(root)) {
    const path = join(root, entry.path)
    if (entry.directory) {
      directories.push(path)
    }
  }
  for (const path of directories.reverse())
    await syncStorageDirectory(path)
}
