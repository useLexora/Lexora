import { z } from 'zod'
import { productIdSchema as id, productRevisionSchema as revision } from './scalars'

export const LIVE_TEXT_WINDOW_UNITS = 16_384
const offset = z.number().int().nonnegative()
const savedRevision = z.string().regex(/^(?:s:[a-f0-9]{64}|c:[1-9]\d{0,15})$/)
const liveRange = z.object({ revision, start: offset, end: offset, total: offset }).strict()
export const productTextRangeSchema = liveRange.extend({ revision: z.union([revision, savedRevision]) })
export const productTextAppendSchema = z.object({
  kind: z.literal('textAppend'),
  messageId: id,
  previousRevision: revision,
  range: liveRange,
  text: z.string().max(LIVE_TEXT_WINDOW_UNITS),
}).strict()
export const productReadLiveTextInputSchema = z.object({ conversationId: id, branchId: id, runId: id, messageId: id, revision, before: offset.positive() }).strict()
export const productReadSavedTextInputSchema = z.object({ conversationId: id, branchId: id, messageId: id, revision: savedRevision, offset, direction: z.enum(['before', 'after']) }).strict()
export type ProductReadSavedTextInput = z.infer<typeof productReadSavedTextInputSchema>
export const productReadLiveTextResultSchema = z.object({ range: productTextRangeSchema, text: z.string().max(LIVE_TEXT_WINDOW_UNITS) }).strict()
export type ProductReadLiveTextInput = z.infer<typeof productReadLiveTextInputSchema>
