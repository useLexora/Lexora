import type { z } from 'zod'
import { z as schema } from 'zod'
import { productRunSchema } from '../../shared/productProtocol/queries'
import { publicRunEventSchema } from '../../shared/runs/publicRunEvent'

const id = schema.string().min(1)
export const readerMessageSchema = schema.object({
  id,
  runId: id.nullable(),
  role: schema.enum(['user', 'assistant', 'tool']),
  authorId: id.nullable(),
  author: schema.string(),
  createdAt: schema.string().nullable().optional(),
  text: schema.string(),
  final: schema.boolean(),
  markdown: schema.boolean(),
  interrupted: schema.boolean(),
  truncated: schema.boolean(),
  showIdentity: schema.boolean(),
  intermediate: schema.boolean(),
  toolName: schema.string().nullable(),
  toolSummary: schema.string(),
  toolTitle: schema.string(),
  toolError: schema.boolean(),
  needsDetail: schema.boolean(),
  loading: schema.boolean(),
  error: schema.string().nullable(),
  notice: schema.string().nullable(),
  hasDetail: schema.boolean(),
  detailResource: schema.string().nullable(),
  actionsVisible: schema.boolean(),
  canEdit: schema.boolean(),
  canRegenerate: schema.boolean(),
  canFollowup: schema.boolean(),
  canCopy: schema.boolean(),
  resources: schema.array(schema.object({ id, name: schema.string(), description: schema.string(), available: schema.boolean() }).strict()),
}).strict()
export const readerEntrySchema = schema.object({ id, continuation: schema.boolean(), messages: schema.array(readerMessageSchema) }).strict()
export const readerTranscriptSchema = schema.object({ events: schema.array(publicRunEventSchema), loaded: schema.boolean().optional(), error: schema.string().nullable().optional(), append: schema.boolean().optional() }).strict()
export const readerUpdateSchema = schema.object({
  appearance: schema.object({ variables: schema.record(schema.string(), schema.string()), colors: schema.record(schema.string(), schema.string()).optional() }).strict().optional(),
  typography: schema.object({ bodySize: schema.number().positive(), bodyLineHeight: schema.number().positive() }).strict().optional(),
  avatars: schema.record(schema.string(), schema.string()).optional(),
  resultRunId: id.nullable().optional(),
  topic: schema.string(),
  reset: schema.boolean(),
  dark: schema.boolean(),
  fontScale: schema.number().positive(),
  language: schema.string().optional(),
  runs: schema.array(productRunSchema).optional(),
  transcripts: schema.record(schema.string(), readerTranscriptSchema).optional(),
  order: schema.array(id).optional(),
  entries: schema.array(readerEntrySchema),
}).strict()
export const readerCopiedSchema = schema.object({ type: schema.literal('copied'), topic: schema.string(), id }).strict()
const action = <T extends string, S extends schema.ZodRawShape>(name: T, fields: S) => schema.object({ action: schema.literal(name), topic: schema.string(), ...fields }).strict()
export const readerActionSchema = schema.discriminatedUnion('action', [
  action('ready', {}),
  action('read-result', { runId: id }),
  action('transcript', { runId: id, retry: schema.literal('true').optional() }),
  action('message', { id }),
  action('edit', { id }),
  action('regenerate', { id }),
  action('followup', { id }),
  action('detail', { id }),
  action('resource', { id, resourceId: id }),
  action('copy', { id: schema.string().optional(), runId: id.optional(), text: schema.string(), feedback: schema.literal('message').optional() }),
  action('link', { href: schema.string() }),
])
export const READER_SCHEMAS = { update: readerUpdateSchema, copied: readerCopiedSchema, action: readerActionSchema }
export type ReaderMessage = z.infer<typeof readerMessageSchema>
export type ReaderWireEntry = z.infer<typeof readerEntrySchema>
export type ReaderUpdate = z.infer<typeof readerUpdateSchema>
export type ReaderAction = z.infer<typeof readerActionSchema>
export type ReaderActionInput = ReaderAction extends infer A ? A extends ReaderAction ? Omit<A, 'topic'> : never : never
export type ReaderSend = (action: ReaderActionInput) => void
