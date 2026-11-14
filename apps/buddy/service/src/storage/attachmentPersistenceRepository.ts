import type { DatabaseSync } from 'node:sqlite'
import type { FileStorage } from '../../../platform/filesystem/fileStorage'
import type { AttachmentRecord } from './attachmentRepository'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { getStorageIsolation } from './StorageIsolation'
import { withTransaction } from './transaction'

export interface ManagedFileRecord {
  id: string
  path: string
  temporaryPath: string | null
  sizeBytes: number
  sha256: string | null
  state: 'preparing' | 'ready' | 'unavailable' | 'deleting' | 'deleted'
  durability: FileStorage['durability'] | 'legacy-verified' | null
}
interface FileRow { id: string, path: string, temporary_path: string | null, size_bytes: number, sha256: string | null, state: ManagedFileRecord['state'], durability: ManagedFileRecord['durability'] }
export interface FilePreparationInput {
  operationId: string
  actorId?: string
  availableBytes: number
  stagingDirectory: string
  ownerInstance: string
  kind: 'import' | 'message' | 'copy' | 'export'
  targetOwnerId: string
  path: string
  sizeBytes: number
  source?: AttachmentRecord
}
export type AttachmentPersistenceRepository = ReturnType<typeof createAttachmentPersistenceRepository>

export function createAttachmentPersistenceRepository(database: DatabaseSync) {
  const isolation = getStorageIsolation(database)
  const find = database.prepare('SELECT * FROM managed_files WHERE path = ?')
  const protection = `NOT EXISTS (SELECT 1 FROM file_references WHERE file_id = managed_files.id)
    AND NOT EXISTS (SELECT 1 FROM file_preparations WHERE state IN ('preparing', 'published')
      AND (id = managed_files.id OR source_file_id = managed_files.id))`
  const get = (path: string): ManagedFileRecord | null => {
    isolation.assertAvailable()
    const row = find.get(path) as FileRow | undefined
    return row ? { id: row.id, path: row.path, temporaryPath: row.temporary_path, sizeBytes: row.size_bytes, sha256: row.sha256, state: row.state, durability: row.durability } : null
  }
  return {
    get,
    prepare(input: FilePreparationInput): ManagedFileRecord {
      if (!isAbsolute(input.path) || !isAbsolute(input.stagingDirectory) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)
        throw new Error('FILE_PREPARATION_INVALID')
      return withTransaction(database, () => {
        const existing = get(input.path)
        if (existing) {
          const preparation = database.prepare('SELECT * FROM file_preparations WHERE id = ?').get(existing.id)
          if (preparation?.operation_id === input.operationId && preparation.owner_instance === input.ownerInstance
            && preparation.kind === input.kind && preparation.target_owner_id === input.targetOwnerId
            && preparation.source_attachment_id === (input.source?.id ?? null)
            && preparation.source_draft_id === (input.source?.draftId ?? null)
            && preparation.source_message_id === (input.source?.messageId ?? null)
            && (preparation.state === 'preparing' || preparation.state === 'published') && existing.sizeBytes === input.sizeBytes) {
            return existing
          }
          throw new Error('FILE_PREPARATION_CONFLICT')
        }
        const reserved = database.prepare('SELECT COALESCE(SUM(reserved_bytes), 0) AS bytes FROM file_preparations WHERE state IN (\'preparing\', \'published\')').get() as { bytes: number }
        if (!Number.isSafeInteger(input.availableBytes) || input.availableBytes < input.sizeBytes + reserved.bytes)
          throw new Error('FILE_STORAGE_CAPACITY')
        const profile = database.prepare('SELECT data_generation, local_actor_id FROM storage_profile WHERE id = 1').get() as { data_generation: string, local_actor_id: string }
        const source = input.source ? get(input.source.storedPath) : null
        if (input.source && (!source || source.state !== 'ready' || source.sizeBytes !== input.source.sizeBytes))
          throw new Error('FILE_SOURCE_UNAVAILABLE')
        const id = randomUUID()
        const now = new Date().toISOString()
        database.prepare(`INSERT INTO managed_files (id, path, temporary_path, size_bytes, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'preparing', ?, ?)`).run(id, input.path, join(input.stagingDirectory, `${id}.part`), input.sizeBytes, now, now)
        database.prepare(`INSERT INTO file_preparations
          (id, operation_id, owner_instance, actor_id, data_generation, kind, target_owner_id, source_file_id,
          source_attachment_id, source_draft_id, source_message_id, state, reserved_bytes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?)`).run(
          id,
          input.operationId,
          input.ownerInstance,
          input.actorId ?? profile.local_actor_id,
          profile.data_generation,
          input.kind,
          input.targetOwnerId,
          source?.id ?? null,
          input.source?.id ?? null,
          input.source?.draftId ?? null,
          input.source?.messageId ?? null,
          input.sizeBytes,
          now,
          now,
        )
        return get(input.path)!
      })
    },
    publish(path: string, proof: { sizeBytes: number, sha256: string, durability: FileStorage['durability'] }): void {
      withTransaction(database, () => {
        const file = get(path)
        if (!file || file.state !== 'preparing' || file.sizeBytes !== proof.sizeBytes || !/^[a-f0-9]{64}$/.test(proof.sha256))
          throw new Error('FILE_PUBLICATION_INVALID')
        const now = new Date().toISOString()
        database.prepare('UPDATE managed_files SET state = \'ready\', sha256 = ?, durability = ?, updated_at = ? WHERE id = ?').run(proof.sha256, proof.durability, now, file.id)
        database.prepare('UPDATE file_preparations SET state = \'published\', updated_at = ? WHERE id = ? AND state = \'preparing\'').run(now, file.id)
      })
    },
    settle(paths: readonly string[], outcome: 'commit' | 'rollback'): void {
      withTransaction(database, () => {
        for (const path of paths) {
          const file = get(path)
          if (!file)
            throw new Error('FILE_PREPARATION_MISSING')
          const referenced = Boolean(database.prepare('SELECT 1 FROM file_references WHERE file_id = ?').get(file.id))
          if (outcome === 'commit' && !referenced)
            throw new Error('ATTACHMENT_OWNERSHIP_NOT_COMMITTED')
          database.prepare('UPDATE file_preparations SET state = ?, reserved_bytes = 0, updated_at = ? WHERE id = ? AND state IN (\'preparing\', \'published\')')
            .run(referenced ? 'settled' : 'aborted', new Date().toISOString(), file.id)
        }
      })
    },
    recover(ownerInstance: string): void {
      withTransaction(database, () => {
        const remote = database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'remote_uploads\'').get()
          ? ' AND NOT EXISTS (SELECT 1 FROM remote_uploads u WHERE u.file_id = file_preparations.id AND u.state IN (\'receiving\', \'ready\'))'
          : ''
        database.prepare(`UPDATE file_preparations SET state = CASE
          WHEN EXISTS (SELECT 1 FROM file_references WHERE file_id = file_preparations.id) THEN 'settled' ELSE 'aborted' END,
          reserved_bytes = 0, updated_at = ?
          WHERE owner_instance <> ? AND state IN ('preparing', 'published')${remote}`).run(new Date().toISOString(), ownerInstance)
      })
    },
    hasProtection(path: string): boolean {
      isolation.assertAvailable()
      return Boolean(database.prepare(`SELECT 1 FROM managed_files WHERE path = ? AND EXISTS
        (SELECT 1 FROM file_preparations WHERE state IN ('preparing', 'published') AND (id = managed_files.id OR source_file_id = managed_files.id))`).get(path))
    },
    claim(path: string): ManagedFileRecord | null {
      return withTransaction(database, () => {
        database.prepare(`UPDATE managed_files SET state = 'deleting', updated_at = ?
          WHERE path = ? AND state IN ('preparing', 'ready', 'unavailable') AND ${protection}`).run(new Date().toISOString(), path)
        const file = get(path)
        return file?.state === 'deleting' ? file : null
      })
    },
    candidates(): ManagedFileRecord[] {
      isolation.assertAvailable()
      return (database.prepare(`SELECT path FROM managed_files WHERE state = 'deleting'
        OR (state IN ('preparing', 'ready', 'unavailable') AND ${protection}) ORDER BY created_at, id LIMIT 100`).all() as { path: string }[]).map(row => get(row.path)!)
    },
    deleted(id: string): void {
      withTransaction(database, () => {
        if (Number(database.prepare('UPDATE managed_files SET state = \'deleted\', updated_at = ? WHERE id = ? AND state = \'deleting\'').run(new Date().toISOString(), id).changes) !== 1)
          throw new Error('FILE_DELETION_NOT_CLAIMED')
      })
    },
    unavailable(path: string): void {
      withTransaction(database, () => {
        database.prepare('UPDATE managed_files SET state = \'unavailable\', updated_at = ? WHERE path = ? AND state = \'ready\'').run(new Date().toISOString(), path)
      })
    },
    adopt(input: { path: string, sizeBytes: number, sha256: string | null }): ManagedFileRecord {
      return withTransaction(database, () => {
        const existing = get(input.path)
        if (existing) {
          if (existing.sizeBytes !== input.sizeBytes || existing.sha256 !== input.sha256)
            throw new Error('FILE_IMPORT_CONFLICT')
          return existing
        }
        if (!isAbsolute(input.path) || (input.sha256 !== null && !/^[a-f0-9]{64}$/.test(input.sha256)))
          throw new Error('FILE_IMPORT_INVALID')
        const now = new Date().toISOString()
        database.prepare(`INSERT INTO managed_files (id, path, size_bytes, sha256, state, durability, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'legacy-verified', ?, ?)`).run(randomUUID(), input.path, input.sizeBytes, input.sha256, input.sha256 ? 'ready' : 'unavailable', now, now)
        database.prepare('UPDATE attachments SET stored_path = stored_path WHERE stored_path = ?').run(input.path)
        return get(input.path)!
      })
    },
    reference(fileId: string, input: { kind: 'export', ownerId: string, bindingId: string }): void {
      withTransaction(database, () => {
        const existing = database.prepare('SELECT file_id FROM file_references WHERE kind = ? AND owner_id = ? AND binding_id = ?').get(input.kind, input.ownerId, input.bindingId)
        if (existing?.file_id === fileId)
          return
        database.prepare('INSERT INTO file_references (file_id, kind, owner_id, binding_id) VALUES (?, ?, ?, ?)').run(fileId, input.kind, input.ownerId, input.bindingId)
      })
    },
    releaseReference(input: { kind: 'export', ownerId: string, bindingId: string }): void {
      withTransaction(database, () => {
        database.prepare('DELETE FROM file_references WHERE kind = ? AND owner_id = ? AND binding_id = ?').run(input.kind, input.ownerId, input.bindingId)
      })
    },
  }
}
