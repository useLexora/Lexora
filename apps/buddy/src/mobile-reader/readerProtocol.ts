import type { z } from 'zod'
import { z as schema } from 'zod'
import { productBranchSchema, productRunSchema } from '../../shared/productProtocol/queries'
import { publicRunEventSchema } from '../../shared/runs/publicRunEvent'

const id = schema.string().min(1)
export const readerMessageSchema = schema.object({
  id,
  runId: id.nullable(),
  branchId: id.optional(),
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
  resources: schema.array(schema.object({
    id,
    name: schema.string(),
    description: schema.string(),
    available: schema.boolean(),
    photo: schema.object({
      revision: id,
      status: schema.enum(['idle', 'loading', 'ready', 'failed', 'unavailable']),
      thumbnail: schema.string().regex(/^https:\/\/appassets\.androidplatform\.net\/artifacts\/[0-9a-f]{64}\.png$/).optional(),
    }).strict().optional(),
  }).strict()),
}).strict()
export const readerEntrySchema = schema.object({ id, continuation: schema.boolean(), messages: schema.array(readerMessageSchema) }).strict()
export const readerTranscriptSchema = schema.object({ events: schema.array(publicRunEventSchema), loaded: schema.boolean().optional(), error: schema.string().nullable().optional(), append: schema.boolean().optional() }).strict()
export const readerOutputSchema = schema.object({
  failed: schema.boolean(),
  items: schema.array(schema.object({ id, revision: schema.string(), name: schema.string(), description: schema.string(), available: schema.boolean(), image: schema.boolean(), thumbnail: schema.string().nullable() }).strict()),
}).strict()
const toolImageIdentity = { runId: id, toolCallId: id, kind: schema.enum(['reference', 'artifact']), id }
export const readerToolImageSchema = schema.object({
  ...toolImageIdentity,
  name: schema.string(),
  thumbnail: schema.string().nullable(),
  loading: schema.boolean(),
  failed: schema.boolean(),
  available: schema.boolean(),
}).strict()
export const readerUpdateSchema = schema.object({
  appearance: schema.object({ variables: schema.record(schema.string(), schema.string()), colors: schema.record(schema.string(), schema.string()).optional() }).strict().optional(),
  typography: schema.object({ bodySize: schema.number().positive(), bodyLineHeight: schema.number().positive() }).strict().optional(),
  avatars: schema.record(schema.string(), schema.string()).optional(),
  branches: schema.array(productBranchSchema).optional(),
  selectedBranchId: id.nullable().optional(),
  outputs: schema.record(schema.string(), readerOutputSchema).optional(),
  toolImages: schema.array(readerToolImageSchema).optional(),
  resultRunId: id.nullable().optional(),
  anchorMessageId: id.nullable().optional(),
  anchorRequestId: id.nullable().optional(),
  hasLaterMessages: schema.boolean().optional(),
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
  action('latest', {}),
  action('read-result', { runId: id }),
  action('transcript', { runId: id, retry: schema.literal('true').optional() }),
  action('outputs', { runId: id, retry: schema.literal('true').optional() }),
  action('artifact', { runId: id, resourceId: id }),
  action('artifact-actions', { runId: id, resourceId: id }),
  action('artifact-thumbnail', { runId: id, resourceId: id }),
  action('tool-image', { ...toolImageIdentity, retry: schema.literal('true').optional() }),
  action('tool-image-preview', toolImageIdentity),
  action('branch', { branchId: id }),
  action('message', { id, contextual: schema.literal(true).optional(), anchor: schema.object({ x: schema.number().min(0).max(1), y: schema.number().min(0).max(1), width: schema.number().min(0).max(1), height: schema.number().min(0).max(1) }).strict().optional() }),
  action('edit', { id }),
  action('regenerate', { id }),
  action('followup', { id }),
  action('detail', { id }),
  action('resource', { id, resourceId: id, revision: id.optional() }),
  action('photo-thumbnail', { id, resourceId: id, revision: id, retry: schema.literal(true).optional() }),
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

export type ReaderOutput = z.infer<typeof readerOutputSchema>
export type ReaderToolImage = z.infer<typeof readerToolImageSchema>
