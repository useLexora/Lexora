import type { StorageReporter } from '../../../platform/storage/storageTree'
import type { StorageOperation } from '../../../shared/storage/storageApi'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { restoreExtensionBackup } from '../../../platform/extensions/restoreExtensionBackup'
import { extractSnapshotFiles } from '../../../platform/storage/extractSnapshotFiles'
import { isMissing, readStorageJson, storageError, syncStorageFile, writeStorageJson } from '../../../platform/storage/storageFiles'
import { restoreCredentialStage } from '../../../platform/storage/storageOperationFiles'
import { copyStorageTree, syncStorageDirectories } from '../../../platform/storage/storageTree'
import { mergeRestoredSyncConnections } from '../../../platform/sync/syncConnectionStore'
import { backupDirectoryAllowed } from '../../../shared/storage/backupScope'
import { revokeRestoredDeviceGrants } from '../privateNetwork/revokeRestoredDeviceGrants'
import { mergeBackupDatabase, selectBackupDatabase } from './backupDatabase'
import { mergeSettings } from './backupSettings'
import { restoreNotificationSoundBackup } from './notificationSoundBackup'
import { activatePersistenceCandidate } from './persistenceMigration/activatePersistenceCandidate'
import { relocateDatabaseReferences, relocateProfileJournals, verifyProfileReferences } from './relocateProfileReferences'
import { sanitizeRestoredDatabase } from './restorePolicy'
import { BUDDY_SCHEMA_VERSION } from './schema'
import { openSnapshotDatabase, rewriteIsolatedSnapshotDatabase, snapshotDatabaseVersion } from './snapshotDatabase'
import { snapshotDirectory, verifyStorageSnapshot } from './StorageSnapshots'
import { withTransaction } from './transaction'

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
  let incomingReferenceRoot = manifest.sourceRoot
  let candidateReferenceRoot = operation.source
  const incomingVersion = snapshotDatabaseVersion(join(incoming, 'buddy/buddy.sqlite3'))
  const candidateVersion = snapshotDatabaseVersion(join(candidate, 'buddy/buddy.sqlite3'))
  if (incomingVersion > BUDDY_SCHEMA_VERSION || candidateVersion > BUDDY_SCHEMA_VERSION) {
    if (incomingVersion <= BUDDY_SCHEMA_VERSION)
      incomingReferenceRoot = await upgradeSnapshotProfile(incoming, incomingReferenceRoot, join(stage, 'convert-incoming'), signal, privateDirectoriesExecutable)
    if (candidateVersion <= BUDDY_SCHEMA_VERSION)
      candidateReferenceRoot = await upgradeSnapshotProfile(candidate, candidateReferenceRoot, join(stage, 'convert-current'), signal, privateDirectoriesExecutable)
  }
  const sourcePath = join(incoming, 'buddy', 'buddy.sqlite3')
  const targetPath = join(candidate, 'buddy', 'buddy.sqlite3')
  const credentialStage = restoreCredentialStage(locationPath, operation.id)
  await rewriteIsolatedSnapshotDatabase(sourcePath, async (source) => {
    sanitizeRestoredDatabase(source, operation.credentials)
    selectBackupDatabase(source, scopes, manifest.files.map(entry => entry.path))
    relocateDatabaseReferences(source, incomingReferenceRoot, operation.target)
    await rewriteIsolatedSnapshotDatabase(targetPath, async (target) => {
      if (candidateReferenceRoot !== operation.target)
        relocateDatabaseReferences(target, candidateReferenceRoot, operation.target)
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
      if (source.prepare('SELECT 1 FROM sqlite_master WHERE name = \'storage_profile\'').get()) {
        withTransaction(target, () => {
          target.prepare('UPDATE storage_profile SET data_generation = ? WHERE id = 1').run(randomUUID())
          target.exec('UPDATE storage_actors SET state = \'revoked\' WHERE kind = \'device\'; DELETE FROM service_admission_gates; UPDATE file_preparations SET state = CASE WHEN EXISTS (SELECT 1 FROM file_references WHERE file_id = file_preparations.id) THEN \'settled\' ELSE \'aborted\' END, reserved_bytes = 0')
          revokeRestoredDeviceGrants(target)
        })
      }
      target.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    })
  })
  if (candidateReferenceRoot !== operation.target)
    await relocateProfileJournals(candidate, candidateReferenceRoot, operation.target, signal)
  await relocateProfileJournals(incoming, incomingReferenceRoot, operation.target, signal)
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
  const references = openSnapshotDatabase(sourcePath)
  try {
    await verifyProfileReferences(references, candidate, operation.target)
  }
  finally { references.close() }
  const database = openSnapshotDatabase(targetPath)
  try {
    if (database.prepare('PRAGMA foreign_key_check').all().length || Object.values(database.prepare('PRAGMA quick_check').get() ?? {})[0] !== 'ok')
      throw storageError('STORAGE_DATABASE_INVALID')
  }
  finally { database.close() }
  await syncStorageFile(targetPath)
  await syncStorageDirectories(candidate)
}

async function upgradeSnapshotProfile(profile: string, referenceRoot: string, conversionRoot: string, signal: AbortSignal, privateDirectoriesExecutable?: string): Promise<string> {
  await rewriteIsolatedSnapshotDatabase(join(profile, 'buddy/buddy.sqlite3'), database => relocateDatabaseReferences(database, referenceRoot, profile))
  await relocateProfileJournals(profile, referenceRoot, profile, signal)
  const converted = await activatePersistenceCandidate({ sourceRoot: profile, candidateRoot: conversionRoot, signal, privateDirectoriesExecutable })
  await rm(profile, { recursive: true })
  await rename(converted.profileRoot, profile)
  return converted.profileRoot
}
