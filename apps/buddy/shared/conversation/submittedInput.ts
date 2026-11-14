import type { ZodType } from 'zod'
import type { buddyUserContentV1Schema } from './buddyUserContent'
import { z } from 'zod'
import { buddyInputDeliverySchema } from './chatApi'
import { buddyComposerDraftExecutionConfigSchema, buddyComposerDraftModelSelectionSchema, buddyComposerDraftScopeSchema, buddyDraftParticipantsSchema } from './composerDraft'

const id = z.string().regex(/^[A-Z0-9][\w-]{0,127}$/i)

export function submittedInputSchema<T extends ZodType>(content: T) {
  return z.object({
    inputId: id,
    scope: buddyComposerDraftScopeSchema,
    content,
    executionConfig: buddyComposerDraftExecutionConfigSchema,
    modelSelection: buddyComposerDraftModelSelectionSchema.nullable(),
    participants: buddyDraftParticipantsSchema.nullable().optional(),
    legacyResourceDraftId: id.optional(),
  }).strict()
}

export function submitInputIntentSchema<T extends ZodType>(content: T) {
  return z.object({
    operation: z.enum(['start', 'edit', 'enqueue', 'command']),
    input: submittedInputSchema(content),
    buddyId: id.optional(),
    delivery: buddyInputDeliverySchema.optional(),
  }).strict().refine(value => value.operation === 'start' || (value.buddyId === undefined && (value.operation === 'enqueue' || value.delivery === undefined)))
}

export type SubmittedInput = z.output<ReturnType<typeof submittedInputSchema<typeof buddyUserContentV1Schema>>>
