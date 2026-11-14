import type { DatabaseSync } from 'node:sqlite'
import type { AttachmentPersistenceRepository } from './attachmentPersistenceRepository'
import { createAttachmentPersistenceRepository } from './attachmentPersistenceRepository'
import { withTransaction } from './transaction'

export interface AttachmentRecord {
  nameSource?: 'file' | 'clipboard'
  sourcePath?: string
  conversationId: string | null
  createdAt: string
  draftId: string | null
  id: string
  messageId: string | null
  mimeType: string
  name: string
  sizeBytes: number
  storedPath: string
}

export interface AttachmentRepository {
  persistence?: AttachmentPersistenceRepository
  create: (record: AttachmentRecord) => AttachmentRecord
  findById: (id: string) => AttachmentRecord | null
  findVisibleById: (id: string) => AttachmentRecord | null
  listAll: () => AttachmentRecord[]
  listDraftsBefore: (createdBefore: string) => AttachmentRecord[]
  listForConversation: (conversationId: string) => AttachmentRecord[]
  removeDraft: (id: string) => boolean
  removeDrafts: (ids: readonly string[]) => number
}

interface AttachmentRow {
  name_source: 'file' | 'clipboard'
  source_path: string | null
  conversation_id: string | null
  created_at: string
  draft_id: string | null
  id: string
  message_id: string | null
  mime_type: string
  name: string
  size_bytes: number
  stored_path: string
}

export function createAttachmentRepository(database: DatabaseSync): AttachmentRepository {
  const selection = `
    SELECT attachments.*, messages.conversation_id
    FROM attachments
    LEFT JOIN messages ON messages.id = attachments.message_id
  `
  const find = database.prepare(`${selection} WHERE attachments.id = ?`)
  const findVisible = database.prepare(`
    ${selection}
    LEFT JOIN conversations ON conversations.id = messages.conversation_id
    WHERE attachments.id = ?
      AND (attachments.draft_id IS NOT NULL OR conversations.deleted_at IS NULL)
  `)
  const insert = database.prepare(`
    INSERT INTO attachments (
      id, draft_id, message_id, stored_path, name, mime_type, size_bytes, created_at, name_source, source_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const listAll = database.prepare(`${selection} ORDER BY attachments.created_at, attachments.id`)
  const listDraftsBefore = database.prepare(`
    ${selection}
    WHERE attachments.draft_id IS NOT NULL AND attachments.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM chat_queue WHERE chat_queue.id = attachments.draft_id AND chat_queue.state IN ('waiting', 'paused'))
    ORDER BY attachments.created_at, attachments.id
  `)
  const listForConversation = database.prepare(`
    ${selection}
    WHERE messages.conversation_id = ?
    ORDER BY attachments.created_at, attachments.id
  `)
  const removeDraft = database.prepare(`
    DELETE FROM attachments WHERE id = ? AND draft_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM chat_queue WHERE chat_queue.id = attachments.draft_id AND chat_queue.state IN ('waiting', 'paused'))
  `)

  return {
    persistence: database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'managed_files\'').get() ? createAttachmentPersistenceRepository(database) : undefined,
    create(record) {
      return withTransaction(database, () => {
        insert.run(
          record.id,
          record.draftId,
          record.messageId,
          record.storedPath,
          record.name,
          record.mimeType,
          record.sizeBytes,
          record.createdAt,
          record.nameSource ?? 'file',
          record.sourcePath ?? null,
        )
        return requireAttachment(find.get(record.id), record.id)
      })
    },
    findById(id) {
      const row = find.get(id) as AttachmentRow | undefined
      return row ? toAttachment(row) : null
    },
    findVisibleById(id) {
      const row = findVisible.get(id) as AttachmentRow | undefined
      return row ? toAttachment(row) : null
    },
    listAll() {
      return (listAll.all() as unknown as AttachmentRow[]).map(toAttachment)
    },
    listDraftsBefore(createdBefore) {
      return (listDraftsBefore.all(createdBefore) as unknown as AttachmentRow[])
        .map(toAttachment)
    },
    listForConversation(conversationId) {
      return (listForConversation.all(conversationId) as unknown as AttachmentRow[])
        .map(toAttachment)
    },
    removeDraft(id) {
      return withTransaction(database, () => Number(removeDraft.run(id).changes) === 1)
    },
    removeDrafts(ids) {
      return withTransaction(database, () => ids.reduce((count, id) => count + Number(removeDraft.run(id).changes), 0))
    },
  }
}

function requireAttachment(value: unknown, id: string): AttachmentRecord {
  const row = value as AttachmentRow | undefined
  if (!row)
    throw new Error(`Lexora Buddy attachment was not persisted: ${id}`)
  return toAttachment(row)
}

function toAttachment(row: AttachmentRow): AttachmentRecord {
  return {
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    draftId: row.draft_id,
    id: row.id,
    messageId: row.message_id,
    mimeType: row.mime_type,
    name: row.name,
    nameSource: row.name_source,
    sourcePath: row.source_path ?? undefined,
    sizeBytes: row.size_bytes,
    storedPath: row.stored_path,
  }
}
