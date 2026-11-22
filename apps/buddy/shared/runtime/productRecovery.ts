import { z } from 'zod'
import { buddyUserContentV1Schema } from '../conversation/buddyUserContent'
import { buddyComposerDraftExecutionConfigSchema, buddyComposerDraftModelSelectionSchema, buddyComposerDraftScopeSchema, buddyDraftParticipantsSchema } from '../conversation/composerDraft'
import { productRevisionSchema } from '../productProtocol/scalars'

export const recoverySourceKindSchema = z.enum(['conversation', 'draft'])

export const productRecoveryItemSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  commandId: z.string(),
  createdAt: z.iso.datetime(),
  method: z.string(),
  state: z.enum(['accepted', 'rejected', 'not_accepted', 'unknown', 'trust_changed']),
  conversationId: z.string().nullable(),
  branchId: z.string().nullable().optional(),
  draftId: z.string().nullable().optional(),
  sourceKind: recoverySourceKindSchema.optional(),
  sourceTitle: z.string().optional(),
  draftInput: z.object({
    executionConfig: buddyComposerDraftExecutionConfigSchema,
    modelSelection: buddyComposerDraftModelSelectionSchema.nullable(),
    participants: buddyDraftParticipantsSchema.nullable().optional(),
    expectedRevision: productRevisionSchema,
    scope: buddyComposerDraftScopeSchema,
    spaceId: z.string().nullable().optional(),
  }).strict().optional(),
  content: buddyUserContentV1Schema.nullable(),
  canRestore: z.boolean(),
}).strict()
export type ProductRecoveryItem = z.infer<typeof productRecoveryItemSchema>
export const productRecoveryTargetSchema = productRecoveryItemSchema.pick({ id: true })
export const productRecoveryListSchema = z.array(productRecoveryItemSchema)
