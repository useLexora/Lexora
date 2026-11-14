import type { PersistenceCandidateInput } from './importPersistenceCandidate'
import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isMissing } from '../../../../platform/storage/storageFiles'
import { acquireStorageRootLease, assertStorageRootLease } from '../../../../platform/storage/StorageRootLease'
import { openBuddyMigrationCandidate } from '../database'
import { BUDDY_STORAGE_WRITER_VERSION } from '../schema'
import { withTransaction } from '../transaction'
import { importPersistenceCandidate } from './importPersistenceCandidate'
import { PERSISTENCE_MIGRATION_ID, PersistenceMigrationError } from './legacyRunHistory'
import { readPersistenceSourceManifest } from './persistenceSources'

export async function activatePersistenceCandidate(input: PersistenceCandidateInput) {
  if (input.sourceLease)
    assertStorageRootLease(input.sourceLease, input.sourceRoot)
  const existing = await readActivatedCandidate(input)
  if (existing)
    return existing
  const candidate = await importPersistenceCandidate(input)
  const release = acquireStorageRootLease(candidate.profileRoot, input.leaseDirectory, input.privateDirectoriesExecutable)
  try {
    const database = openBuddyMigrationCandidate({ databasePath: join(candidate.profileRoot, 'buddy/buddy.sqlite3') })
    try {
      input.signal.throwIfAborted()
      withTransaction(database, () => {
        const migration = database.prepare('SELECT source_fingerprint, state FROM persistence_migrations WHERE id = ?').get(PERSISTENCE_MIGRATION_ID)
        if (migration?.state !== 'verified' || migration.source_fingerprint !== candidate.sourceFingerprint)
          throw new PersistenceMigrationError('MIGRATION_NOT_VERIFIED')
        const result = database.prepare(`UPDATE storage_profile SET authority = 'sqlite', migration_state = 'ready', min_writer_version = ?
          WHERE id = 1 AND authority = 'legacy_jsonl' AND migration_state = 'pending'`).run(BUDDY_STORAGE_WRITER_VERSION)
        if (result.changes !== 1)
          throw new PersistenceMigrationError('MIGRATION_NOT_PENDING')
        database.prepare(`UPDATE persistence_migrations SET state = 'activated' WHERE id = ?`).run(PERSISTENCE_MIGRATION_ID)
      })
    }
    finally { database.close() }
    return candidate
  }
  finally { release() }
}

async function readActivatedCandidate(input: PersistenceCandidateInput) {
  const manifest = await readPersistenceSourceManifest(input.candidateRoot)
  if (!manifest || !manifest.workingCopyReady)
    return null
  if (manifest.scope !== (input.scope ?? 'profile') || manifest.sourceRoot !== resolve(input.sourceRoot))
    throw new PersistenceMigrationError('MIGRATION_SOURCE_CHANGED')
  const profileRoot = join(input.candidateRoot, 'profile')
  const path = join(profileRoot, 'buddy/buddy.sqlite3')
  const exists = await access(path).then(() => true, (error) => {
    if (!isMissing(error))
      throw error
    return false
  })
  if (!exists)
    return null
  const release = acquireStorageRootLease(profileRoot, input.leaseDirectory, input.privateDirectoriesExecutable)
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { readOnly: true })
    if (!database.prepare('SELECT 1 FROM sqlite_master WHERE name = \'persistence_migrations\'').get())
      return null
    const migration = database.prepare('SELECT state, source_fingerprint FROM persistence_migrations WHERE id = ?').get(PERSISTENCE_MIGRATION_ID)
    if (migration?.state !== 'activated')
      return null
    const profile = database.prepare('SELECT authority, migration_state, min_writer_version FROM storage_profile WHERE id = 1').get()
    if (migration.source_fingerprint !== manifest.fingerprint || profile?.authority !== 'sqlite' || profile.migration_state !== 'ready'
      || profile.min_writer_version !== BUDDY_STORAGE_WRITER_VERSION) {
      throw new PersistenceMigrationError('MIGRATION_CANDIDATE_CHANGED')
    }
    const count = (kind: string) => Number(database!.prepare('SELECT COUNT(*) AS count FROM persistence_migration_entries WHERE migration_id = ? AND kind = ?').get(PERSISTENCE_MIGRATION_ID, kind)!.count)
    return { profileRoot, sourceFingerprint: manifest.fingerprint, runs: count('run'), files: count('file') }
  }
  finally {
    database?.close()
    release()
  }
}
