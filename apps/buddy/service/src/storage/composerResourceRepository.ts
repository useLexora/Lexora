import type { DatabaseSync } from 'node:sqlite'
import type { BuddyComposerResourceMetadata, BuddyComposerSourceOrigin, BuddySpaceFileOrigin } from '../../../shared/conversation/composerResource'
import { buddyComposerSourceOriginSchema } from '../../../shared/conversation/composerResource'
import { withTransaction } from './database'

export interface ComposerResourceRecord extends BuddyComposerResourceMetadata {
  attachmentId: string | null
  contentHash: string | null
  createdAt: string
  draftId: string
  errorCode: 'IMPORT_FAILED' | 'IMPORT_INTERRUPTED' | null
  state: 'importing' | 'ready' | 'failed'
  source: BuddyComposerSourceOrigin | null
  updatedAt: string
}

interface ComposerResourceRow {
  attachment_id: string | null
  content_hash: string | null
  created_at: string
  draft_id: string
  error_code: ComposerResourceRecord['errorCode']
  id: string
  mime_type: string
  name: string
  name_source: 'file' | 'clipboard'
  source_path: string | null
  size_bytes: number
  state: ComposerResourceRecord['state']
  source_json: string | null
  updated_at: string
}

export type ComposerResourceRepository = ReturnType<typeof createComposerResourceRepository>

export class ComposerResourceConflictError extends Error {}

export function createComposerResourceRepository(database: DatabaseSync) {
  const find = database.prepare('SELECT * FROM composer_resources WHERE id = ?')
  const listAll = database.prepare('SELECT * FROM composer_resources ORDER BY created_at, id')
  const list = database.prepare('SELECT * FROM composer_resources WHERE draft_id = ? ORDER BY created_at, id')
  const remove = database.prepare('DELETE FROM composer_resources WHERE id = ? AND draft_id = ?')
  const insert = database.prepare(`
    INSERT INTO composer_resources (id, draft_id, name, mime_type, size_bytes, state, created_at, updated_at, name_source, source_path)
    VALUES (?, ?, ?, ?, ?, 'importing', ?, ?, ?, ?)
  `)
  const finish = database.prepare(`
    UPDATE composer_resources SET state = 'ready', attachment_id = ?, content_hash = ?, updated_at = ?
    WHERE id = ? AND draft_id = ? AND state = 'importing'
  `)
  const fail = database.prepare(`
    UPDATE composer_resources SET state = 'failed', error_code = ?, updated_at = ?
    WHERE id = ? AND draft_id = ? AND state = 'importing'
  `)
  const retry = database.prepare(`
    UPDATE composer_resources SET state = 'importing', error_code = NULL, updated_at = ?
    WHERE id = ? AND draft_id = ? AND state = 'failed'
  `)
  const interrupt = database.prepare(`
    UPDATE composer_resources SET state = 'failed', error_code = 'IMPORT_INTERRUPTED', updated_at = ?
    WHERE state = 'importing'
  `)
  const failUnavailableAttachment = database.prepare(`
    UPDATE composer_resources
    SET state = 'failed', attachment_id = NULL, content_hash = NULL,
      error_code = 'IMPORT_INTERRUPTED', updated_at = ?
    WHERE attachment_id = ? AND state = 'ready'
  `)
  const insertSource = database.prepare(`
    INSERT INTO composer_resources (id, draft_id, name, mime_type, size_bytes, state, source_json, created_at, updated_at, name_source, source_path)
    VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)
  `)
  const findSource = database.prepare('SELECT * FROM composer_resources WHERE draft_id = ? AND source_json = ?')

  function acceptOne(draftId: string, resource: BuddyComposerResourceMetadata, now: string): ComposerResourceRecord {
    const existing = find.get(resource.resourceId) as ComposerResourceRow | undefined
    if (existing) {
      if (
        existing.source_json !== null || existing.draft_id !== draftId || existing.name !== resource.name
        || existing.name_source !== (resource.nameSource ?? 'file')
        || existing.source_path !== (resource.sourcePath ?? null)
        || existing.mime_type !== resource.mimeType || existing.size_bytes !== resource.sizeBytes
      ) {
        throw new ComposerResourceConflictError('Resource identity conflict')
      }
      return toResource(existing)
    }
    insert.run(resource.resourceId, draftId, resource.name, resource.mimeType, resource.sizeBytes, now, now, resource.nameSource ?? 'file', resource.sourcePath ?? null)
    return toResource(find.get(resource.resourceId) as unknown as ComposerResourceRow)
  }

  return {
    acceptBatch(draftId: string, resources: readonly { metadata: BuddyComposerResourceMetadata, source?: BuddyComposerSourceOrigin }[], now: string): ComposerResourceRecord[] {
      return withTransaction(database, () => resources.map(resource => resource.source
        ? this.selectSource(draftId, resource.metadata, resource.source, now, false)
        : acceptOne(draftId, resource.metadata, now)))
    },
    selectSource(draftId: string, resource: BuddyComposerResourceMetadata, source: BuddyComposerSourceOrigin, now: string, reuseSource = true) {
      const sourceJson = JSON.stringify(buddyComposerSourceOriginSchema.parse(source))
      const existing = find.get(resource.resourceId) as ComposerResourceRow | undefined
      if (existing) {
        if (existing.draft_id !== draftId || existing.source_json === null || sourceIdentity(existing.source_json) !== sourceIdentity(sourceJson))
          throw new ComposerResourceConflictError('Resource identity conflict')
        return toResource(existing)
      }
      const selected = reuseSource
        ? 'localReference' in source
          ? (list.all(draftId) as unknown as ComposerResourceRow[]).find(row => row.source_json !== null && sourceIdentity(row.source_json) === sourceIdentity(sourceJson))
          : findSource.get(draftId, sourceJson) as ComposerResourceRow | undefined
        : undefined
      if (selected)
        return toResource(selected)
      insertSource.run(resource.resourceId, draftId, resource.name, resource.mimeType, resource.sizeBytes, sourceJson, now, now, resource.nameSource ?? 'file', resource.sourcePath ?? null)
      return toResource(find.get(resource.resourceId) as unknown as ComposerResourceRow)
    },
    selectSpaceFile(draftId: string, resource: BuddyComposerResourceMetadata, source: BuddySpaceFileOrigin, now: string) {
      return this.selectSource(draftId, resource, source, now)
    },
    accept(draftId: string, resources: readonly BuddyComposerResourceMetadata[], now: string) {
      return withTransaction(database, () => resources.map(resource => acceptOne(draftId, resource, now)))
    },
    findById(id: string): ComposerResourceRecord | null {
      const row = find.get(id) as ComposerResourceRow | undefined
      return row ? toResource(row) : null
    },
    listAll(): ComposerResourceRecord[] {
      return (listAll.all() as unknown as ComposerResourceRow[]).map(toResource)
    },
    listForDraft(draftId: string): ComposerResourceRecord[] {
      return (list.all(draftId) as unknown as ComposerResourceRow[]).map(toResource)
    },
    remove(draftId: string, resourceIds: readonly string[]) {
      return withTransaction(database, () => resourceIds.reduce(
        (count, resourceId) => count + Number(remove.run(resourceId, draftId).changes),
        0,
      ))
    },
    finish(input: { attachmentId: string, contentHash: string, draftId: string, now: string, resourceId: string }) {
      return withTransaction(database, () => Number(finish.run(input.attachmentId, input.contentHash, input.now, input.resourceId, input.draftId).changes) === 1)
    },
    fail(draftId: string, resourceId: string, errorCode: 'IMPORT_FAILED' | 'IMPORT_INTERRUPTED', now: string) {
      return withTransaction(database, () => Number(fail.run(errorCode, now, resourceId, draftId).changes) === 1)
    },
    retry(draftId: string, resourceId: string, now: string) {
      return withTransaction(database, () => Number(retry.run(now, resourceId, draftId).changes) === 1)
    },
    interruptImports(now: string) {
      return withTransaction(database, () => Number(interrupt.run(now).changes))
    },
    failUnavailableAttachments(attachmentIds: readonly string[], now: string) {
      return withTransaction(database, () => attachmentIds.reduce(
        (count, attachmentId) => count + Number(failUnavailableAttachment.run(now, attachmentId).changes),
        0,
      ))
    },
  }
}

function sourceIdentity(value: string): string {
  const source = buddyComposerSourceOriginSchema.parse(JSON.parse(value))
  return JSON.stringify('localReference' in source ? { kind: source.localReference.kind, path: source.localReference.path, origin: source.origin } : source)
}

function toResource(row: ComposerResourceRow): ComposerResourceRecord {
  return {
    attachmentId: row.attachment_id,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    draftId: row.draft_id,
    errorCode: row.error_code,
    mimeType: row.mime_type,
    name: row.name,
    nameSource: row.name_source,
    sourcePath: row.source_path ?? undefined,
    resourceId: row.id,
    sizeBytes: row.size_bytes,
    state: row.state,
    source: row.source_json ? buddyComposerSourceOriginSchema.parse(JSON.parse(row.source_json)) : null,
    updatedAt: row.updated_at,
  }
}
