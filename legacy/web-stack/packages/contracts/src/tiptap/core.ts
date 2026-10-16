import type { TiptapJsonMarkPayload, TiptapJsonNodePayload } from './_typing'
import { z } from 'zod'
import { TIPTAP_SCHEMA_VERSION } from './constants'

export { TIPTAP_SCHEMA_VERSION } from './constants'

const TiptapJsonMarkPayloadSchema = z.object({
  type: z.string(),
  attrs: z.record(z.string(), z.unknown()).optional(),
}).strict() satisfies z.ZodType<TiptapJsonMarkPayload>

const TiptapJsonNodePayloadSchema: z.ZodType<TiptapJsonNodePayload> = z.lazy(() =>
  z.object({
    type: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    text: z.string().optional(),
    content: z.array(TiptapJsonNodePayloadSchema).optional(),
    marks: z.array(TiptapJsonMarkPayloadSchema).optional(),
  }).strict(),
)

export const TiptapSchemaVersionSchema = z.literal(TIPTAP_SCHEMA_VERSION)
export const TiptapJsonContentPayloadSchema = z.array(TiptapJsonNodePayloadSchema)

export type TiptapJsonContent = z.infer<typeof TiptapJsonContentPayloadSchema>
export type TiptapJsonNode = TiptapJsonContent[number]
export type TiptapSchemaVersion = z.infer<typeof TiptapSchemaVersionSchema>
