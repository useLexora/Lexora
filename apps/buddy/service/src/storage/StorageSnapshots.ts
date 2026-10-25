import type { StorageReporter } from '../../../platform/storage/storageTree'
import type { BackupOptions } from '../../../shared/storage/backupScope'
import type { SnapshotManifest } from '../../../shared/storage/snapshot'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensurePrivateDirectories } from '../../../platform/filesystem/privateDirectories'
import { packSnapshotFile } from '../../../platform/storage/snapshotFile'
import { readSnapshotManifest, writeSnapshotManifest } from '../../../platform/storage/SnapshotRepository'
import { storageError, syncStorageDirectory, syncStorageFile } from '../../../platform/storage/storageFiles'
import { copyStorageTree, syncStorageDirectories, walkStorage } from '../../../platform/storage/storageTree'
import { verifySnapshotFiles } from '../../../platform/storage/verifySnapshotFiles'
import { backupDirectoryAllowed, backupScopes } from '../../../shared/storage/backupScope'
import { snapshotManifestSchema } from '../../../shared/storage/snapshot'
import { selectBackupDatabase } from './backupDatabase'
import { portableSettings } from './backupSettings'
import { openBuddyDatabase } from './database'
import { prepareNotificationSoundBackup } from './notificationSoundBackup'
import { sanitizeRestoredDatabase } from './restorePolicy'
import { BUDDY_SCHEMA_VERSION } from './schema'

export function snapshotDirectory(root: string, id: string): string {
  return join(root, 'exports', 'snapshots', id)
}
export async function createStorageSnapshot(root: string, dataId: string, signal: AbortSignal, report: StorageReporter, privateDirectoriesExecutable?: string, options: BackupOptions & { automatic?: string } = { scopes: [...backupScopes], credentials: false }, encryptedCredentials?: Uint8Array): Promise<SnapshotManifest> {
  const id = randomUUID()
  const directory = snapshotDirectory(root, id)
  const stage = snapshotDirectory(root, `.storage-${id}`)
  let excludedLinks = 0
  await ensurePrivateDirectories([stage], privateDirectoriesExecutable)
  try {
    const allowed = (path: string) => backupDirectoryAllowed(path, options.scopes) || /^buddy\/buddy\.sqlite3-(?:wal|shm)$/.test(path)
    const links = new Set<string>()
    const paths: string[] = []
    for await (const entry of walkStorage(root, path => !allowed(path))) {
      paths.push(entry.path)
      if (entry.link !== null) {
        links.add(entry.path)
        excludedLinks++
      }
    }
    await copyStorageTree(root, join(stage, 'files'), { signal, report, privateDirectoriesExecutable, exclude: path => !allowed(path) || links.has(path) })
    signal.throwIfAborted()
    if (!(await lstat(join(stage, 'files', 'buddy', 'buddy.sqlite3'))).isFile())
      throw storageError('SNAPSHOT_DATABASE_MISSING')
    const database = openBuddyDatabase({ databasePath: join(stage, 'files', 'buddy', 'buddy.sqlite3') })
    try {
      sanitizeRestoredDatabase(database, !!encryptedCredentials)
      selectBackupDatabase(database, options.scopes, paths)
      if (Object.values(database.prepare('PRAGMA quick_check').get() ?? {})[0] !== 'ok' || database.prepare('PRAGMA foreign_key_check').all().length)
        throw storageError('SNAPSHOT_DATABASE_INVALID')
      database.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)')
    }
    finally {
      database.close()
    }
    await syncStorageFile(join(stage, 'files', 'buddy', 'buddy.sqlite3'))
    if (options.scopes.includes('settings')) {
      const path = join(stage, 'files', 'config.toml')
      const text = await readFile(path, 'utf8').catch((error) => {
        if (error.code === 'ENOENT')
          return null
        throw error
      })
      await prepareNotificationSoundBackup(join(stage, 'files', 'buddy'), text ?? '', signal)
      if (text !== null)
        await writeFile(path, portableSettings(text), { mode: 0o600, flush: true })
    }
    if (encryptedCredentials)
      await writeFile(join(stage, 'files', 'credentials.enc'), encryptedCredentials, { mode: 0o600, flush: true })
    const files: SnapshotManifest['files'] = []
    for await (const entry of walkStorage(join(stage, 'files'))) {
      signal.throwIfAborted()
      if (entry.directory) {
        files.push({ kind: 'directory', path: entry.path })
        continue
      }
      if (entry.link !== null)
        throw storageError('SNAPSHOT_INVALID_LINK')
      files.push({ kind: 'file', path: entry.path, executable: entry.executable, ...await packSnapshotFile(join(stage, 'files', entry.path), entry.size, entry.executable, signal) })
    }
    const manifest = snapshotManifestSchema.parse({ version: 4, ...(options.automatic ? { automatic: options.automatic } : {}), scopes: options.scopes, credentials: !!encryptedCredentials, id, dataId, sourceRoot: root, createdAt: new Date().toISOString(), databaseVersion: BUDDY_SCHEMA_VERSION, files, excludedLinks })
    await verifySnapshotFiles(stage, manifest, signal)
    await writeSnapshotManifest(stage, manifest)
    await syncStorageDirectories(stage)
    signal.throwIfAborted()
    await rename(stage, directory)
    await syncStorageDirectory(join(root, 'exports', 'snapshots'))
    return manifest
  }
  catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}
export async function verifyStorageSnapshot(directory: string, signal: AbortSignal): Promise<SnapshotManifest> {
  const manifest = await readSnapshotManifest(directory)
  if (manifest.databaseVersion > BUDDY_SCHEMA_VERSION)
    throw storageError('SNAPSHOT_NEWER_VERSION')
  await verifySnapshotFiles(directory, manifest, signal)
  return manifest
}
