import type { UserMessage } from '@earendil-works/pi-ai'
import type { AttachmentDocumentReference } from '../../attachments/AttachmentDocumentReference'
import type { AttachmentImageReference } from '../../attachments/AttachmentImageReference'
import { z } from 'zod'
import { BUDDY_DOCUMENT_MIME_TYPES } from '../../../../shared/conversation/attachmentFormats'

const buddyInputImageReferenceSchema = z.object({
  attachmentId: z.string().min(1).max(256),
  mimeType: z.string().startsWith('image/').max(128),
}).strict()

const buddyInputReferenceSchema = z.object({
  attachmentIds: z.array(z.string().min(1).max(256)).max(16).optional(),
  resourceLabels: z.record(z.string().min(1).max(256), z.string().regex(/^\[(?:(?:IMAGE|FILE)#|Image #)\d+\]$/)).optional(),
  documents: z.array(z.object({
    attachmentId: z.string().min(1).max(256),
    mimeType: z.enum(BUDDY_DOCUMENT_MIME_TYPES),
  }).strict()).max(16).optional(),
  images: z.array(buddyInputImageReferenceSchema).max(16),
  messageId: z.string().min(1).max(256),
  prompt: z.string().max(4 * 1024 * 1024),
  version: z.literal(1),
}).strict().refine((input) => {
  const nativeIds = [...input.images, ...input.documents ?? []].map(file => file.attachmentId)
  if (nativeIds.length > 16 || new Set(nativeIds).size !== nativeIds.length)
    return false
  return !input.attachmentIds || (new Set(input.attachmentIds).size === input.attachmentIds.length
    && nativeIds.every(id => input.attachmentIds!.includes(id)))
})

export interface BuddyInputReferenceV1 {
  attachmentIds?: string[]
  resourceLabels?: Record<string, string>
  documents?: AttachmentDocumentReference[]
  images: AttachmentImageReference[]
  messageId: string
  prompt: string
  version: 1
}

export interface BuddyInputReferenceMessage extends UserMessage {
  buddyInput: BuddyInputReferenceV1
}

export interface BuddyInputReferenceStore {
  pending: BuddyInputReferenceV1 | null
}

export class BuddyInputReferenceError extends Error {
  readonly code: 'INPUT_REFERENCE_INVALID' | 'INPUT_REFERENCE_MISMATCH'

  constructor(code: BuddyInputReferenceError['code']) {
    super('Lexora Buddy input reference is invalid')
    this.name = 'BuddyInputReferenceError'
    this.code = code
  }
}

export function createBuddyInputReference(input: Omit<BuddyInputReferenceV1, 'version'>): BuddyInputReferenceV1 {
  return buddyInputReferenceSchema.parse({ ...input, version: 1 })
}

export function createBuddyInputPlaceholderContent(
  input: BuddyInputReferenceV1,
): UserMessage['content'] {
  return [
    { text: input.prompt, type: 'text' },
    ...input.images.map(image => ({
      data: '',
      mimeType: image.mimeType,
      type: 'image' as const,
    })),
  ]
}

export function createBuddyInputReferenceMessage(
  input: BuddyInputReferenceV1,
  timestamp: number,
): BuddyInputReferenceMessage {
  return {
    buddyInput: input,
    content: createBuddyInputPlaceholderContent(input),
    role: 'user',
    timestamp,
  }
}

export function readBuddyInputReference(message: unknown): BuddyInputReferenceV1 | null {
  if (!message || typeof message !== 'object' || Array.isArray(message))
    return null
  const record = message as Record<string, unknown>
  if (record.role !== 'user' || !('buddyInput' in record))
    return null
  const result = buddyInputReferenceSchema.safeParse(record.buddyInput)
  if (!result.success)
    throw new BuddyInputReferenceError('INPUT_REFERENCE_INVALID')
  return result.data
}

export function matchesBuddyInputText(
  content: UserMessage['content'],
  input: BuddyInputReferenceV1,
): boolean {
  return Array.isArray(content)
    && content.length === 1
    && content[0]?.type === 'text'
    && content[0].text === input.prompt
}
