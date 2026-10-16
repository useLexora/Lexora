import { z } from 'zod'
import { BROWSER_MAX_OBSERVATION_TEXT_BYTES, browserElementRefSchema, browserFrameIdSchema, browserIdSchema, browserRuntimeUrlSchema } from './primitives'

export const BROWSER_MAX_READ_ITEMS = 100
export const browserReadModeSchema = z.enum(['text', 'links', 'tables'])
export const browserReadTargetSchema = z.object({
  documentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  frameId: browserFrameIdSchema,
  observationId: browserIdSchema,
  ref: browserElementRefSchema,
}).strict()

export const browserReadOptionsSchema = z.object({
  cursor: z.string().max(128).regex(/^[\da-f-]{36}:\d{1,6}$/i).optional(),
  maxItems: z.number().int().min(1).max(BROWSER_MAX_READ_ITEMS).optional(),
  mode: browserReadModeSchema.optional(),
  selector: z.string().trim().min(1).max(512).optional(),
  target: browserReadTargetSchema.optional(),
}).strict().superRefine((input, context) => {
  if ((input.cursor && (input.mode || input.selector || input.target)) || (input.selector && input.target)) {
    context.addIssue({ code: 'custom', message: 'Continue with only cursor and maxItems; select a region with either selector or target' })
  }
})

export const browserReadParamsSchema = browserReadOptionsSchema.safeExtend({
  pageId: browserIdSchema,
  sessionId: browserIdSchema,
})

export const browserReadItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().max(2_048) }).strict(),
  z.object({ kind: z.literal('link'), text: z.string().max(1_024), url: z.string().max(4_096), urlRedacted: z.boolean().optional() }).strict(),
  z.object({
    caption: z.string().max(512),
    cells: z.array(z.string().max(128)).max(32),
    kind: z.literal('table-row'),
    rowIndex: z.number().int().nonnegative(),
    tableIndex: z.number().int().nonnegative(),
  }).strict(),
])

export const browserReadSourceSchema = z.object({
  items: z.array(browserReadItemSchema).max(2_000),
  sourceTruncated: z.boolean(),
  url: z.string().max(4_096),
}).strict()

export const browserReadContentSchema = z.object({
  cursor: z.string().max(128).optional(),
  documentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  frameId: browserFrameIdSchema,
  items: z.array(browserReadItemSchema).max(BROWSER_MAX_READ_ITEMS),
  mode: browserReadModeSchema,
  pageId: browserIdSchema,
  sessionId: browserIdSchema,
  sourceTruncated: z.boolean(),
  title: z.string().max(512),
  truncated: z.boolean(),
  url: z.union([z.literal('about:blank'), browserRuntimeUrlSchema]),
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= BROWSER_MAX_OBSERVATION_TEXT_BYTES, 'Browser read exceeds the serialized text limit')

export type BrowserReadOptions = z.infer<typeof browserReadOptionsSchema>
export type BrowserReadParams = z.infer<typeof browserReadParamsSchema>
export type BrowserReadContent = z.infer<typeof browserReadContentSchema>
export type BrowserReadSource = z.infer<typeof browserReadSourceSchema>
export type BrowserReadItem = z.infer<typeof browserReadItemSchema>
