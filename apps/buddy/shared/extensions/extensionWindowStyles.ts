import { z } from 'zod'

export const windowStyleIdSchema = z.string().min(1).max(180)
export const windowStyleSchema = z.object({ id: windowStyleIdSchema, css: z.string() }).strict()
export type ExtensionWindowStyle = z.infer<typeof windowStyleSchema>
