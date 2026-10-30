import { z } from 'zod'

export const imageReadingLimits = { inputBytes: 32 * 1024 * 1024, textBytes: 128 * 1024 } as const
export const ocrServiceInputSchema = z.object({ api: z.literal('paddleocr'), endpoint: z.url({ protocol: /^https?$/ }) }).strict()
export const ocrServiceConfigSchema = ocrServiceInputSchema.extend({ credentialId: z.uuid().optional() }).strict()
export type OcrServiceConfig = z.infer<typeof ocrServiceConfigSchema>
export const ocrServiceSaveSchema = z.object({
  service: ocrServiceInputSchema,
  credential: z.string().trim().min(1).max(8192).regex(/^[^\r\n]+$/).nullable().optional(),
}).strict()
export type OcrServiceSave = z.infer<typeof ocrServiceSaveSchema>
export const ocrServiceStatusSchema = z.object({ service: ocrServiceInputSchema.nullable(), hasCredential: z.boolean() }).strict()
export type OcrServiceStatus = z.infer<typeof ocrServiceStatusSchema>
export const ocrReadRequestSchema = z.object({
  service: ocrServiceConfigSchema,
  image: z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), data: z.string().min(1).max(imageReadingLimits.inputBytes).regex(/^[a-z0-9+/]+={0,2}$/i) }).strict(),
}).strict()
export const ocrReadResultSchema = z.object({ text: z.string().max(imageReadingLimits.textBytes) }).strict()
export const ocrRpc = { read: 'host.images.ocr.read' } as const
export const OCR_IPC = { status: 'lexora:images:ocr:status', save: 'lexora:images:ocr:save' } as const
