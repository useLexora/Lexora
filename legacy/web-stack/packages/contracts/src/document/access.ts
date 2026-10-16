import { z } from 'zod'

export const DocumentAccessSourceSchema = z.enum(['OWNER', 'WORKSPACE'])

export const DocumentAccessCapabilitiesSchema = z.object({
  canRead: z.boolean(),
  canEdit: z.boolean(),
  canCreateChild: z.boolean(),
  canPublish: z.boolean(),
  canMove: z.boolean(),
  canTrash: z.boolean(),
  canRestore: z.boolean(),
}).strict()

export const DocumentAccessSchema = z.object({
  source: DocumentAccessSourceSchema,
  capabilities: DocumentAccessCapabilitiesSchema,
}).strict()

export type DocumentAccessSource = z.infer<typeof DocumentAccessSourceSchema>
export type DocumentAccessCapabilities = z.infer<typeof DocumentAccessCapabilitiesSchema>
export type DocumentAccess = z.infer<typeof DocumentAccessSchema>
