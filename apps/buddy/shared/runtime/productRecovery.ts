import { z } from 'zod'
import { buddyUserContentV1Schema } from '../conversation/buddyUserContent'

export const productRecoveryItemSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  commandId: z.string(),
  createdAt: z.iso.datetime(),
  method: z.string(),
  state: z.enum(['accepted', 'rejected', 'not_accepted', 'unknown', 'trust_changed']),
  conversationId: z.string().nullable(),
  content: buddyUserContentV1Schema.nullable(),
  canRestore: z.boolean(),
}).strict()
export type ProductRecoveryItem = z.infer<typeof productRecoveryItemSchema>
export const productRecoveryTargetSchema = productRecoveryItemSchema.pick({ id: true })
export const productRecoveryListSchema = z.array(productRecoveryItemSchema)
