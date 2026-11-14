import type { Buffer } from 'node:buffer'
import type { AttachmentRecord } from '../storage/attachmentRepository'

export interface AttachmentInputScope {
  conversationId: string | null
  draftId?: string | null
  legacyResourceDraftId?: string
}

export interface AttachmentInputReader {
  get: (id: string, scope: AttachmentInputScope) => AttachmentRecord
  read: (record: AttachmentRecord) => Promise<Buffer>
  inspect: (record: AttachmentRecord) => Promise<{ isFile: boolean, size: number }>
}
