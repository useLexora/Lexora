import type { BuddyResourceQuote, BuddyUserContentV1 } from '../conversation/buddyUserContent'
import { z } from 'zod'
import { buddyUserContentV1Schema } from '../conversation/buddyUserContent'
import { ProductProtocolError } from './errors'
import { productIdSchema } from './scalars'

const resourceQuoteSchema = z.object({
  id: productIdSchema,
  resourceId: productIdSchema,
  text: z.string().min(1).max(262_144),
  textOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  title: z.string().max(512),
}).strict()
const contentFields = buddyUserContentV1Schema.unwrap().shape
export const productEditableContentSchema = z.object({
  version: contentFields.version,
  body: contentFields.body,
  panelResourceIds: contentFields.panelResourceIds,
  quotes: contentFields.quotes,
  resourceQuotes: z.array(resourceQuoteSchema).max(16).optional(),
  sessionReferences: contentFields.sessionReferences,
}).strict().refine(content => content.body.every(paragraph => paragraph.content.every(node =>
  (node.type !== 'session_ref' || content.sessionReferences?.some(reference => reference.id === node.sessionId))
  && (node.type !== 'quote_ref' || (node.quoteKind === 'message' ? content.quotes : content.resourceQuotes)?.some(quote => quote.id === node.quoteId)),
)), 'Missing material metadata').refine((content) => {
  const quotes = [...content.quotes ?? [], ...content.resourceQuotes ?? []]
  return quotes.length <= 16 && new Set(quotes.map(quote => quote.id)).size === quotes.length && quotes.reduce((sum, quote) => sum + quote.text.length, 0) <= 1_048_576
})
export type ProductEditableContent = z.infer<typeof productEditableContentSchema>
export const productContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('editable'), content: productEditableContentSchema }).strict(),
  z.object({ kind: z.literal('unsupported'), contentReference: productIdSchema, version: z.number().int().nonnegative(), summary: z.string().max(4096), readOnly: z.literal(true) }).strict(),
])

export function assertProductContentActions(content: ProductEditableContent, allowedActions: ReadonlySet<string>): void {
  for (const paragraph of content.body) {
    for (const node of paragraph.content) {
      if (node.type === 'prompt_directive' && node.directive === 'slash_command' && node.commandMode === 'action' && (!node.commandId || !allowedActions.has(node.commandId)))
        throw new ProductProtocolError('ACTION_NOT_ALLOWED')
    }
  }
}

export function projectProductContent(content: BuddyUserContentV1, publishQuote: (quote: BuddyResourceQuote) => { resourceId: string, title: string }): ProductEditableContent {
  return productEditableContentSchema.parse({
    ...content,
    ...(content.resourceQuotes ? { resourceQuotes: content.resourceQuotes.map(quote => ({ id: quote.id, text: quote.text, ...('textOffset' in quote && quote.textOffset !== undefined ? { textOffset: quote.textOffset } : {}), ...publishQuote(quote) })) } : {}),
  })
}

export function restoreProductContent(content: ProductEditableContent, resolveQuote: (resourceId: string) => BuddyResourceQuote): BuddyUserContentV1 {
  return buddyUserContentV1Schema.parse({
    ...content,
    ...(content.resourceQuotes
      ? { resourceQuotes: content.resourceQuotes.map((quote) => {
          const source = resolveQuote(quote.resourceId)
          if (source.id !== quote.id || source.text !== quote.text || ('textOffset' in source ? source.textOffset : undefined) !== quote.textOffset)
            throw new ProductProtocolError('SOURCE_CHANGED')
          return source
        }) }
      : {}),
  })
}
