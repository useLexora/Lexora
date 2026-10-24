import { z } from 'zod'

export const extensionDocumentInfoSchema = z.object({ title: z.string().trim().min(1).max(256), dirty: z.boolean() }).strict()
export type ExtensionDocumentInfo = z.infer<typeof extensionDocumentInfoSchema>
