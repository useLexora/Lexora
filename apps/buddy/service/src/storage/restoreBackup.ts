import type { StorageReporter } from '../../../platform/storage/storageTree'
import type { StorageOperation } from '../../../shared/storage/storageApi'
import { createHash } from 'node:crypto'
import { lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { restoreExtensionBackup } from '../../../platform/extensions/restoreExtensionBackup'
import { extractSnapshotFiles } from '../../../platform/storage/extractSnapshotFiles'
import { isMissing, readStorageJson, storageError, syncStorageFile, writeStorageJson } from '../../../platform/storage/storageFiles'
import { restoreCredentialStage } from '../../../platform/storage/storageOperationFiles'
import { copyStorageTree, syncStorageDirectories } from '../../../platform/storage/storageTree'
import { mergeRestoredSyncConnections } from '../../../platform/sync/syncConnectionStore'
import { backupDirectoryAllowed } from '../../../shared/storage/backupScope'
import { mergeBackupDatabase, selectBackupDatabase } from './backupDatabase'
import { mergeSettings } from './backupSettings'
import { openBuddyDatabase } from './database'
import { restoreNotificationSoundBackup } from './notificationSoundBackup'
import { relocateDatabaseReferences, relocateProfileJournals, verifyProfileReferences } from './relocateProfileReferences'
import { sanitizeRestoredDatabase } from './restorePolicy'
import { snapshotDirectory, verifyStorageSnapshot } from './StorageSnapshots'

export async function prepareBackupRestore(operation: StorageOperation, stage: string, locationPath: string, signal: AbortSignal, report: StorageReporter, privateDirectoriesExecutable?: string): Promise<void> {
  if (!operation.snapshotId)
    throw storageError('SNAPSHOT_MISSING')
  const directory = snapshotDirectory(operation.source, operation.snapshotId)
  const manifest = await verifyStorageSnapshot(directory, signal)
  const scopes = operation.scopes ?? manifest.scopes
  if (!scopes.length || scopes.some(scope => !manifest.scopes.includes(scope)))
    throw storageError('SNAPSHOT_SCOPE_MISSING')
  const candidate = join(stage, 'profile')
  const incoming = join(stage, 'incoming')
  const options = { signal, report, privateDirectoriesExecutable }
  await copyStorageTree(join(operation.source, 'buddy'), join(candidate, 'buddy'), { ...options, destinationRoot: join(operation.target, 'buddy') })
  await extractSnapshotFiles(directory, incoming, manifest, { ...options, exclude: path => !backupDirectoryAllowed(path, scopes) })
  const sourcePath = join(incoming, 'buddy', 'buddy.sqlite3')
  const targetPath = join(candidate, 'buddy', 'buddy.sqlite3')
  const source = openBuddyDatabase({ databasePath: sourcePath })
  const target = openBuddyDatabase({ databasePath: targetPath })
  const credentialStage = restoreCredentialStage(locationPath, operation.id)
  try {
    sanitizeRestoredDatabase(source, operation.credentials)
    selectBackupDatabase(source, scopes, manifest.files.map(entry => entry.path))
    relocateDatabaseReferences(source, manifest.sourceRoot, operation.target)
    for (const [scope, table, namespace] of [['providers', 'provider_states', 'providers'], ['connections', 'mcp_servers', 'connectors']] as const) {
      if (!scopes.includes(scope))
        continue
      for (const row of source.prepare(`SELECT * FROM ${table}`).iterate()) {
        const id = String(row.provider_id ?? row.id)
        const refs = namespace === 'connectors' ? [row.credential_ref, target.prepare('SELECT credential_ref FROM mcp_servers WHERE id = ?').get(id)?.credential_ref] : [id]
        for (const ref of refs) {
          if (typeof ref === 'string')
            await rm(join(candidate, 'buddy', 'secrets', namespace, `${createHash('sha256').update(ref).digest('hex')}.credential`), { force: true })
        }
      }
    }
    for (const table of ['provider_configs', 'mcp_servers']) {
      for (const row of source.prepare(`SELECT id, credential_ref FROM ${table} WHERE credential_ref IS NOT NULL`).iterate()) {
        const namespace = table === 'provider_configs' ? 'providers' : 'connectors'
        const path = join(credentialStage, 'secrets', namespace, `${createHash('sha256').update(String(row.credential_ref)).digest('hex')}.credential`)
        if (!await lstat(path).catch((error) => {
          if (isMissing(error))
            return null
          throw error
        })) {
          source.prepare(`UPDATE ${table} SET credential_ref = NULL WHERE id = ?`).run(row.id!)
        }
      }
    }
    mergeBackupDatabase(target, source, scopes)
    target.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }
  finally {
    source.close()
    target.close()
  }
  await relocateProfileJournals(incoming, manifest.sourceRoot, operation.target, signal)
  await copyStorageTree(incoming, candidate, { ...options, overwrite: true, exclude: path => path === 'credentials.enc' || /^buddy\/notification-sounds(?:\/|$)/.test(path) || /^buddy\/buddy\.sqlite3(?:-|$)/.test(path) || path === 'config.toml' || path === 'device/sync.json' || /^buddy\/extensions\/(?:installed|schedules)\.json$/.test(path) })
  if (scopes.includes('settings')) {
    const text = await readFile(join(incoming, 'config.toml'), 'utf8').catch((error) => {
      if (isMissing(error))
        return null
      throw error
    })
    if (text !== null) {
      const current = await readFile(join(operation.source, 'config.toml'), 'utf8').catch((error) => {
        if (isMissing(error))
          return ''
        throw error
      })
      const restored = await restoreNotificationSoundBackup(join(incoming, 'buddy'), join(candidate, 'buddy'), current, text, signal)
      await writeFile(join(candidate, 'config.toml'), mergeSettings(current, restored), { mode: 0o600, flush: true })
    }
  }
  if (scopes.includes('connections')) {
    const imported = await readStorageJson(join(incoming, 'device', 'sync.json'))
    if (imported) {
      const current = await readStorageJson(join(operation.source, 'device', 'sync.json'))
      await writeStorageJson(join(candidate, 'device', 'sync.json'), mergeRestoredSyncConnections(current, imported))
    }
  }
  if (scopes.includes('plugins'))
    await restoreExtensionBackup(join(incoming, 'buddy', 'extensions'), join(candidate, 'buddy', 'extensions'))
  if (operation.credentials && await lstat(join(credentialStage, 'secrets')).catch((error) => {
    if (isMissing(error))
      return null
    throw error
  })) {
    await copyStorageTree(join(credentialStage, 'secrets'), join(candidate, 'buddy', 'secrets'), { ...options, overwrite: true })
  }
  const references = openBuddyDatabase({ databasePath: sourcePath })
  try {
    await verifyProfileReferences(references, candidate, operation.target)
  }
  finally { references.close() }
  const database = openBuddyDatabase({ databasePath: targetPath })
  try {
    if (database.prepare('PRAGMA foreign_key_check').all().length || Object.values(database.prepare('PRAGMA quick_check').get() ?? {})[0] !== 'ok')
      throw storageError('STORAGE_DATABASE_INVALID')
  }
  finally { database.close() }
  await syncStorageFile(targetPath)
  await syncStorageDirectories(candidate)
}
