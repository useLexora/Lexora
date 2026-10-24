import { z } from 'zod'

export const EXTENSION_CLIPBOARD_BYTES_LIMIT = 4 * 1024 * 1024
export const extensionClipboardSchema = z.object({
  text: z.string().max(EXTENSION_CLIPBOARD_BYTES_LIMIT).optional(),
  html: z.string().max(EXTENSION_CLIPBOARD_BYTES_LIMIT).optional(),
}).strict().refine(value => new TextEncoder().encode(value.text ?? '').byteLength + new TextEncoder().encode(value.html ?? '').byteLength <= EXTENSION_CLIPBOARD_BYTES_LIMIT, 'Clipboard data is too large')
export const extensionClipboardWriteSchema = extensionClipboardSchema.refine(value => value.text !== undefined || value.html !== undefined, 'Clipboard data is required')
export type ExtensionClipboardData = z.infer<typeof extensionClipboardSchema>
