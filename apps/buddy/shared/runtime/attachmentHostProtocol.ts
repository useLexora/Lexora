import { z } from 'zod'

export const ATTACHMENT_PREVIEW_BYTES_LIMIT = 8 * 1024 * 1024
export const attachmentPreviewBytesSchema = z.object({
  mimeType: z.string().regex(/^image\//),
  data: z.string().max(Math.ceil(ATTACHMENT_PREVIEW_BYTES_LIMIT / 3) * 4).regex(/^[a-z0-9+/]*={0,2}$/i),
}).strict()
