import type { DatabaseSync } from 'node:sqlite'
import type { BuddyDataPaths } from './BuddyDataPaths'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { withTransaction } from './database'
import { ExecutionResourceQueries } from './ExecutionResourceQueries'

export type ConversationStorageAuthority = 'legacy_jsonl' | 'sqlite'

export interface ConversationPurgeManifest {
  draftIds: string[]
  fileIds: string[]
  contentReferenceIds: string[]
}

export class ConversationPurgeError extends Error {
  readonly code: string

  constructor(code: string, options?: ErrorOptions) {
    super(code, options)
    this.code = code
    this.name = 'ConversationPurgeError'
  }
}

export function isPurgeDescendant(directory: string, path: string): boolean {
  if (!isAbsolute(path))
    return false
  const suffix = relative(directory, resolve(path))
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

export class ConversationPurgeRepository {
  private readonly database: DatabaseSync
  private readonly paths: BuddyDataPaths
  private readonly storageAuthority: ConversationStorageAuthority

  constructor(database: DatabaseSync, paths: BuddyDataPaths, storageAuthority: ConversationStorageAuthority) {
    this.database = database
    this.paths = paths
    this.storageAuthority = storageAuthority
  }

  directories(id: string, manifest: ConversationPurgeManifest): string[] {
    return [this.paths.conversationDirectory(id), ...manifest.draftIds.map(draftId => resolve(this.paths.draftAttachments(draftId), '..'))]
  }

  stagingFiles(manifest: ConversationPurgeManifest): string[] {
    if (this.storageAuthority === 'legacy_jsonl')
      return []
    return this.database.prepare('SELECT id, temporary_path FROM managed_files WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(manifest.fileIds))
      .flatMap((row) => {
        if (!/^[A-Z0-9][\w-]{0,127}$/i.test(String(row.id)))
          throw new ConversationPurgeError('CONVERSATION_FILE_BOUNDARY')
        const expected = resolve(this.paths.root, 'managed-files', 'staging', `${row.id}.part`)
        return row.temporary_path === expected ? [expected] : []
      })
  }

  prepare(id: string): ConversationPurgeManifest | null {
    const db = this.database
    return withTransaction(db, () => {
      const job = db.prepare('SELECT status, manifest_json FROM conversation_deletion_jobs WHERE conversation_id = ?').get(id)
      if (!job)
        return null
      if (job.status !== 'pending')
        throw new ConversationPurgeError('CONVERSATION_DELETION_FAILED')
      if (!db.prepare('SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NOT NULL').get(id))
        throw new ConversationPurgeError('CONVERSATION_DELETION_STATE_CHANGED')
      if (new ExecutionResourceQueries(db).conversation(id) !== 'released') {
        throw new ConversationPurgeError('CONVERSATION_RESOURCES_BUSY')
      }
      const manifest: ConversationPurgeManifest = job.manifest_json
        ? JSON.parse(String(job.manifest_json))
        : {
            draftIds: db.prepare(`SELECT id FROM composer_drafts WHERE conversation_id = ?
              UNION SELECT id FROM chat_queue WHERE conversation_id = ?`).all(id, id).map(row => String(row.id)),
            fileIds: [],
            contentReferenceIds: [],
          }
      if (this.storageAuthority === 'sqlite') {
        const directories = this.directories(id, manifest)
        const files = db.prepare('SELECT id, path FROM managed_files').all().filter(row => directories.some(directory => isPurgeDescendant(directory, String(row.path))))
        manifest.fileIds = [...new Set([...manifest.fileIds, ...files.map(row => String(row.id))])]
        manifest.contentReferenceIds = db.prepare(`SELECT DISTINCT reference_id FROM product_content_reference_owners
          WHERE (owner_kind = 'conversation' AND owner_id = ?)
            OR (owner_kind = 'draft' AND owner_id IN (SELECT value FROM json_each(?)))`)
          .all(id, JSON.stringify(manifest.draftIds))
          .map(row => String(row.reference_id))
      }
      this.assertReferences(id, manifest)
      db.prepare('UPDATE conversation_deletion_jobs SET manifest_json = ? WHERE conversation_id = ?').run(JSON.stringify(manifest), id)
      db.exec('SAVEPOINT purge_preflight')
      try {
        this.erase(id, manifest)
        if (db.prepare('PRAGMA foreign_key_check').all().length)
          throw new ConversationPurgeError('CONVERSATION_REFERENCED')
      }
      finally {
        db.exec('ROLLBACK TO purge_preflight; RELEASE purge_preflight')
      }
      if (this.storageAuthority === 'sqlite') {
        this.releaseOwnedFileReferences(id, manifest)
        db.prepare(`UPDATE managed_files SET state = 'deleting', updated_at = ?
          WHERE id IN (SELECT value FROM json_each(?)) AND state <> 'deleted'`).run(new Date().toISOString(), JSON.stringify(manifest.fileIds))
      }
      return manifest
    })
  }

  finish(id: string, manifest: ConversationPurgeManifest): void {
    this.database.exec('PRAGMA secure_delete = ON')
    withTransaction(this.database, () => {
      this.assertReferences(id, manifest)
      this.erase(id, manifest)
      if (this.database.prepare('PRAGMA foreign_key_check').all().length)
        throw new ConversationPurgeError('CONVERSATION_REFERENCED')
      this.database.prepare('DELETE FROM conversation_deletion_jobs WHERE conversation_id = ?').run(id)
    })
  }

  private assertReferences(id: string, manifest: ConversationPurgeManifest): void {
    const db = this.database
    const draftIds = JSON.stringify(manifest.draftIds)
    if (db.prepare(`SELECT 1 FROM execution_mailbox_sources m JOIN runs source ON source.id = m.source_run_id
      JOIN runs target ON target.id = m.target_run_id WHERE (source.conversation_id = ? AND target.conversation_id <> ?)
        OR (target.conversation_id = ? AND source.conversation_id <> ?)
      UNION ALL SELECT 1 FROM execution_work_attempts w JOIN runs owner ON owner.id = w.run_id
        JOIN runs work ON work.id = w.work_id WHERE work.conversation_id = ? AND owner.conversation_id <> ?
      UNION ALL SELECT 1 FROM conversation_publications p JOIN runs r ON r.id = p.run_id
        WHERE r.conversation_id = ? AND p.conversation_id <> ?
      UNION ALL SELECT 1 FROM messages m JOIN conversation_branches b ON b.id = m.branch_id
        WHERE b.conversation_id = ? AND m.conversation_id <> ?
      UNION ALL SELECT 1 FROM chat_queue q JOIN conversation_branches b ON b.id = q.branch_id
        WHERE b.conversation_id = ? AND q.conversation_id <> ?`).get(id, id, id, id, id, id, id, id, id, id, id, id)) {
      throw new ConversationPurgeError('CONVERSATION_REFERENCED')
    }
    if (this.storageAuthority === 'sqlite')
      this.assertManagedFileReferences(id, manifest)
    if (db.prepare(`SELECT 1 FROM composer_drafts WHERE id IN (SELECT value FROM json_each(?))
      AND (conversation_id IS NULL OR conversation_id <> ?)
      UNION ALL SELECT 1 FROM chat_queue WHERE id IN (SELECT value FROM json_each(?)) AND conversation_id <> ?`).get(draftIds, id, draftIds, id)) {
      throw new ConversationPurgeError('CONVERSATION_FILES_REFERENCED')
    }
    const directories = this.directories(id, manifest)
    const paths = db.prepare(`SELECT stored_path AS path FROM attachments WHERE
      (message_id IS NULL AND draft_id IS NULL)
      OR (message_id IS NOT NULL AND message_id NOT IN (SELECT id FROM messages WHERE conversation_id = ?))
      OR (draft_id IS NOT NULL AND draft_id NOT IN (SELECT value FROM json_each(?)))
      UNION ALL SELECT pi_session_file FROM runs WHERE conversation_id <> ? AND pi_session_file IS NOT NULL
      UNION ALL SELECT session_file FROM conversation_pi_trees WHERE conversation_id <> ?
      UNION ALL SELECT b.session_file FROM execution_thread_bindings b JOIN execution_threads t ON t.id = b.thread_id WHERE t.conversation_id <> ?
      UNION ALL SELECT current_path FROM artifacts WHERE conversation_id <> ?
      UNION ALL SELECT before_snapshot_path FROM run_file_change_captures c JOIN run_change_sets s ON s.id = c.change_set_id WHERE s.conversation_id <> ?
      UNION ALL SELECT after_snapshot_path FROM run_file_change_captures c JOIN run_change_sets s ON s.id = c.change_set_id WHERE s.conversation_id <> ?
      UNION ALL SELECT canonical_root FROM conversation_directory_grants WHERE conversation_id <> ? AND revoked_at IS NULL
      UNION ALL SELECT canonical_root FROM space_directory_bindings WHERE revoked_at IS NULL`).all(id, draftIds, id, id, id, id, id, id, id)
    if (paths.some(row => typeof row.path === 'string' && directories.some(directory => resolve(String(row.path)) === directory || isPurgeDescendant(directory, String(row.path)))))
      throw new ConversationPurgeError('CONVERSATION_FILES_REFERENCED')
    if (db.prepare(`SELECT 1 FROM composer_resources WHERE attachment_id IN (
        SELECT id FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)
        OR draft_id IN (SELECT value FROM json_each(?))) AND draft_id NOT IN (SELECT value FROM json_each(?))`).get(id, draftIds, draftIds)) {
      throw new ConversationPurgeError('CONVERSATION_FILES_REFERENCED')
    }
  }

  private assertManagedFileReferences(id: string, manifest: ConversationPurgeManifest): void {
    const db = this.database
    const draftIds = JSON.stringify(manifest.draftIds)
    const fileIds = JSON.stringify(manifest.fileIds)
    if (db.prepare(`SELECT 1 FROM file_preparations WHERE state IN ('preparing', 'published')
      AND (id IN (SELECT value FROM json_each(?)) OR source_file_id IN (SELECT value FROM json_each(?))
        OR target_owner_id IN (SELECT value FROM json_each(?))
        OR target_owner_id IN (SELECT id FROM messages WHERE conversation_id = ?))`).get(fileIds, fileIds, draftIds, id)) {
      throw new ConversationPurgeError('CONVERSATION_RESOURCES_BUSY')
    }
    if (db.prepare(`SELECT 1 FROM file_references f WHERE f.file_id IN (SELECT value FROM json_each(?)) AND NOT (
      (f.kind = 'message' AND f.owner_id IN (SELECT id FROM messages WHERE conversation_id = ?))
      OR (f.kind IN ('draft', 'queue') AND f.owner_id IN (SELECT value FROM json_each(?))))`).get(fileIds, id, draftIds)
      || db.prepare(`SELECT 1 FROM file_preparations WHERE source_file_id IN (SELECT value FROM json_each(?))
        AND id NOT IN (SELECT value FROM json_each(?))`).get(fileIds, fileIds)) {
      throw new ConversationPurgeError('CONVERSATION_FILES_REFERENCED')
    }
  }

  private releaseOwnedFileReferences(id: string, manifest: ConversationPurgeManifest): void {
    this.database.prepare(`DELETE FROM file_references WHERE
      (kind = 'message' AND owner_id IN (SELECT id FROM messages WHERE conversation_id = ?))
      OR (kind IN ('draft', 'queue') AND owner_id IN (SELECT value FROM json_each(?)))`).run(id, JSON.stringify(manifest.draftIds))
  }

  private erase(id: string, manifest: ConversationPurgeManifest): void {
    const db = this.database
    const draftIds = JSON.stringify(manifest.draftIds)
    db.exec('PRAGMA defer_foreign_keys = ON')
    if (this.storageAuthority === 'sqlite')
      this.releaseOwnedFileReferences(id, manifest)
    db.prepare('DELETE FROM composer_resources WHERE draft_id IN (SELECT value FROM json_each(?))').run(draftIds)
    db.prepare(`DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)
      OR draft_id IN (SELECT value FROM json_each(?))`).run(id, draftIds)
    if (this.storageAuthority === 'sqlite')
      this.eraseManagedContent(id, manifest)
    db.prepare('DELETE FROM run_mutation_leases WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ?)').run(id)
    db.prepare('DELETE FROM automation_occurrences WHERE conversation_id = ?').run(id)
    db.prepare('DELETE FROM task_attention WHERE conversation_id = ?').run(id)
    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ?').run(id)
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  private eraseManagedContent(id: string, manifest: ConversationPurgeManifest): void {
    const db = this.database
    const draftIds = JSON.stringify(manifest.draftIds)
    const fileIds = JSON.stringify(manifest.fileIds)
    db.prepare(`DELETE FROM remote_upload_chunks WHERE upload_id IN (SELECT id FROM remote_uploads WHERE file_id IN (SELECT value FROM json_each(?)))`).run(fileIds)
    db.prepare('DELETE FROM remote_uploads WHERE file_id IN (SELECT value FROM json_each(?))').run(fileIds)
    db.prepare('DELETE FROM remote_exports WHERE file_id IN (SELECT value FROM json_each(?))').run(fileIds)
    db.prepare('DELETE FROM file_preparations WHERE id IN (SELECT value FROM json_each(?))').run(fileIds)
    db.prepare(`UPDATE managed_files SET state = 'deleted' WHERE id IN (SELECT value FROM json_each(?))`).run(fileIds)
    db.prepare('DELETE FROM managed_files WHERE id IN (SELECT value FROM json_each(?))').run(fileIds)
    db.prepare(`DELETE FROM product_content_reference_owners WHERE
      (owner_kind = 'conversation' AND owner_id = ?)
      OR (owner_kind = 'draft' AND owner_id IN (SELECT value FROM json_each(?)))`).run(id, draftIds)
    db.prepare(`DELETE FROM product_content_references WHERE id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM product_content_reference_owners WHERE reference_id = product_content_references.id)`)
      .run(JSON.stringify(manifest.contentReferenceIds))
    db.prepare(`DELETE FROM composer_draft_slots WHERE draft_id IN (SELECT value FROM json_each(?)) OR json_extract(scope_key, '$[2]') = ?`).run(draftIds, id)
  }
}
