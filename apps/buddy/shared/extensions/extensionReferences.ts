import type { BuddyViewQuote } from '../conversation/buddyUserContent'
import type { BuddyComposerSource } from '../conversation/composerResource'
import { z } from 'zod'
import { BUDDY_QUOTE_TEXT_LIMIT } from '../conversation/buddyUserContent'
import { referenceLocatorSchema } from '../conversation/referenceMaterial'
import { extensionFileOpeningSourceSchema } from './extensionFileOpening'
import { extensionIdSchema } from './extensionManifest'

export const extensionReferenceInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('content'),
    source: z.literal('view').optional(),
    title: z.string().trim().min(1).max(512),
    text: z.string().min(1).max(BUDDY_QUOTE_TEXT_LIMIT).refine(text => text.trim().length > 0),
    locator: referenceLocatorSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('resource'),
    resource: z.object({ id: z.string().uuid() }).strict(),
  }).strict(),
])
export type ExtensionReferenceInput = z.infer<typeof extensionReferenceInputSchema>

export const extensionReferenceTargetSchema = z.object({
  extensionId: extensionIdSchema,
  viewId: z.string().uuid(),
  viewType: z.string().min(1).max(180).regex(/^[a-z][a-z0-9.-]+$/),
  source: extensionFileOpeningSourceSchema.nullable(),
}).strict()
export type ExtensionReferenceTarget = z.infer<typeof extensionReferenceTargetSchema>

export const extensionReferenceOpeningSchema = extensionReferenceTargetSchema.extend({
  reuse: z.object({ id: z.string().uuid(), generation: z.string().min(1), token: z.string().min(1) }).strict().optional(),
})
export type ExtensionReferenceOpening = z.infer<typeof extensionReferenceOpeningSchema>

export interface ExtensionReferenceReveal {
  readonly referenceId: string
  readonly text: string
  readonly locator: z.infer<typeof referenceLocatorSchema> | null
}

export type ExtensionReferenceMaterial
  = | { kind: 'quote', quote: BuddyViewQuote }
    | { kind: 'source', source: BuddyComposerSource }
    | { kind: 'file', name: string, mimeType: string, base64: string }
