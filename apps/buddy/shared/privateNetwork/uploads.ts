import { z } from 'zod'
import { BUDDY_DOCUMENT_MIME_TYPES, BUDDY_MEDIA_FILE_BYTES_LIMIT } from '../conversation/attachmentFormats'
import { BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT, BUDDY_TEXT_ATTACHMENT_BYTES_LIMIT, BUDDY_TEXT_ATTACHMENT_MIME_TYPES, isTextAttachmentMimeType } from '../conversation/attachmentPolicy'
import { productIdSchema as id, productRevisionSchema as revision } from '../productProtocol/scalars'

export const REMOTE_UPLOAD_POLICY = {
  maxBytes: BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT,
  textBytes: BUDDY_TEXT_ATTACHMENT_BYTES_LIMIT,
  mediaBytes: BUDDY_MEDIA_FILE_BYTES_LIMIT,
  textMimeTypes: BUDDY_TEXT_ATTACHMENT_MIME_TYPES,
  imageMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  documentMimeTypes: BUDDY_DOCUMENT_MIME_TYPES,
} as const

export const uploadDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const uploadMetadataSchema = z.object({
  name: z.string().trim().min(1).max(255).refine(value => !/[\\/]/.test(value) && [...value].every(char => char.charCodeAt(0) >= 32)),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative().max(BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT),
  sha256: uploadDigestSchema,
}).strict().refine(({ mimeType, sizeBytes }) => {
  if (isTextAttachmentMimeType(mimeType))
    return sizeBytes <= BUDDY_TEXT_ATTACHMENT_BYTES_LIMIT
  if ((REMOTE_UPLOAD_POLICY.imageMimeTypes as readonly string[]).includes(mimeType))
    return sizeBytes <= BUDDY_MEDIA_FILE_BYTES_LIMIT
  if (mimeType === 'application/pdf')
    return true
  return (BUDDY_DOCUMENT_MIME_TYPES as readonly string[]).includes(mimeType) && sizeBytes <= BUDDY_MEDIA_FILE_BYTES_LIMIT
})
export const uploadCommandIntents = {
  'uploads.stage': z.object({ inputId: id, file: uploadMetadataSchema }).strict(),
  'uploads.create': z.object({ draftId: id, expectedRevision: revision, file: uploadMetadataSchema }).strict(),
  'uploads.complete': z.object({ uploadId: id }).strict(),
  'uploads.cancel': z.object({ uploadId: id }).strict(),
  'uploads.adopt': z.object({ uploadId: id, draftId: id, expectedRevision: revision }).strict(),
} as const
export type UploadCommandMethod = keyof typeof uploadCommandIntents
export const uploadStateSchema = z.object({
  uploadId: id,
  draftId: id,
  expectedRevision: revision,
  inputId: id.optional(),
  state: z.enum(['receiving', 'ready', 'adopted', 'cancelled', 'expired', 'failed']),
  confirmedBytes: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: uploadDigestSchema,
  expiresAt: z.iso.datetime(),
  resourceId: id.nullable(),
  contentVersion: uploadDigestSchema.nullable(),
  attachmentId: id.nullable(),
}).strict()
export const uploadGetSchema = z.object({ uploadId: id }).strict()
export const uploadChunkResultSchema = z.object({ uploadId: id, confirmedBytes: z.number().int().nonnegative() }).strict()
