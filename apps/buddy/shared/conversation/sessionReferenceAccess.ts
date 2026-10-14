import { z } from 'zod'
import { idSchema } from '../runtime/apiValidation'

export const SESSION_REFERENCE_CHAIN_DEPTH = 3
export const SESSION_REFERENCE_COUNT_LIMIT = 24
export const SESSION_REFERENCE_MESSAGE_LIMIT = 512

export const sessionReferenceAccessSchema = z.object({
  id: idSchema,
  title: z.string(),
  branchId: idSchema.nullable(),
  depth: z.number().int().min(0).max(SESSION_REFERENCE_CHAIN_DEPTH),
  via: z.array(z.object({ id: idSchema, title: z.string() }).strict()),
  status: z.enum(['available', 'revoked', 'unavailable', 'branch_changed']),
}).strict()
export const sessionReferenceAccessListSchema = z.object({
  references: z.array(sessionReferenceAccessSchema).max(SESSION_REFERENCE_COUNT_LIMIT),
  truncated: z.boolean(),
  depthLimit: z.literal(SESSION_REFERENCE_CHAIN_DEPTH),
  countLimit: z.literal(SESSION_REFERENCE_COUNT_LIMIT),
}).strict()
export type SessionReferenceAccess = z.infer<typeof sessionReferenceAccessSchema>
export type SessionReferenceAccessList = z.infer<typeof sessionReferenceAccessListSchema>
