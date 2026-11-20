import { z } from 'zod'
import { idSchema } from './apiValidation'

export const attachmentHostRpc = { readPreview: 'attachments.readPreview' } as const

export const ATTACHMENT_PREVIEW_BYTES_LIMIT = 8 * 1024 * 1024
const version = z.string().regex(/^[a-f0-9]{64}$/)
export const attachmentPreviewReadSchema = z.object({ attachmentId: idSchema, ifVersion: version.nullable().optional() }).strict()
const attachmentPreviewBytesSchema = z.object({
  version: version.optional(),
  mimeType: z.string().regex(/^image\//),
  data: z.string().max(Math.ceil(ATTACHMENT_PREVIEW_BYTES_LIMIT / 3) * 4).regex(/^[a-z0-9+/]*={0,2}$/i),
}).strict()

export const attachmentPreviewResultSchema = z.union([attachmentPreviewBytesSchema, z.object({ unchanged: version }).strict()])
export type AttachmentPreviewResult = z.infer<typeof attachmentPreviewResultSchema>
