import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema, timestampSchema } from '../runtime/apiValidation'

export const changeSetSummarySchema = z.object({
  changeSetId: idSchema,
  conversationId: idSchema,
  coverage: z.enum(['complete', 'partial']),
  fileCount: z.number().int().nonnegative(),
  runId: idSchema,
  status: z.enum(['capturing', 'completed']),
  updatedAt: timestampSchema,
}).strict()

export const fileChangeDetailSchema = z.object({
  afterSizeBytes: z.number().int().nonnegative().nullable(),
  afterText: z.string().max(1024 * 1024).nullable(),
  beforeSizeBytes: z.number().int().nonnegative().nullable(),
  beforeText: z.string().max(1024 * 1024).nullable(),
  changeType: z.enum(['created', 'deleted', 'modified']),
  id: idSchema,
  language: z.string().max(64).nullable(),
  path: z.string().min(1).max(4096),
  preview: z.enum(['binary', 'oversized', 'sensitive', 'text', 'unavailable']),
  redacted: z.boolean(),
  source: z.object({
    actorId: idSchema.nullable(),
    actorName: z.string().min(1).max(80).nullable(),
    runId: idSchema,
    segmentId: idSchema,
    sequence: z.number().int().positive(),
    invocationIds: z.array(idSchema).min(1),
  }).strict().nullable().optional(),
}).strict()

export const changeSetDetailSchema = changeSetSummarySchema.extend({
  files: z.array(fileChangeDetailSchema),
}).strict()

export type LocalChangeSetDetail = DeepReadonly<z.infer<typeof changeSetDetailSchema>>

export type LocalChangeSetSummary = DeepReadonly<z.infer<typeof changeSetSummarySchema>>

export type LocalFileChangeDetail = DeepReadonly<z.infer<typeof fileChangeDetailSchema>>

export const changeOverviewSchema = z.object({
  coverage: z.enum(['complete', 'partial']),
  files: z.array(fileChangeDetailSchema),
  status: z.enum(['capturing', 'completed']),
  updatedAt: timestampSchema.nullable(),
}).strict()

export const changeOverviewRequestSchema = z.object({
  conversationId: idSchema,
  branchId: idSchema,
}).strict()

export type LocalChangeOverview = DeepReadonly<z.infer<typeof changeOverviewSchema>>
export type ChangeOverviewRequest = z.infer<typeof changeOverviewRequestSchema>

export const changesRequestSchemas = {
  changeSet: z.object({ changeSetId: idSchema }).strict(),
} as const

export const changesResponseSchemas = {
  changeSet: changeSetDetailSchema,
} as const

export const changesRpc = {
  overview: { method: 'changes.overview', input: changeOverviewRequestSchema, response: changeOverviewSchema },
  get: { method: 'changes.get', input: changesRequestSchemas.changeSet, response: changesResponseSchemas.changeSet },
} as const satisfies Record<string, RuntimeRequestContract>

export const changeRecoveryItemSchema = z.object({
  invocationId: idSchema,
  runId: idSchema,
  conversationId: idSchema.nullable(),
  taskTitle: z.string().max(512),
  occurredAt: timestampSchema,
  affectedResources: z.array(z.string().min(1).max(4096)),
  reason: z.string().min(1).max(128),
  status: z.enum(['active', 'unknown']),
  revision: z.string().min(1).max(256),
}).strict()

export const changeRecoveryListRequestSchema = z.object({
  conversationId: idSchema,
}).strict()

export const changeRecoveryRecheckRequestSchema = changeRecoveryListRequestSchema.extend({
  invocationIds: z.array(idSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length),
}).strict()

export const changeRecoveryResolveRequestSchema = changeRecoveryListRequestSchema.extend({
  items: z.array(z.object({
    invocationId: idSchema,
    revision: z.string().min(1).max(256),
  }).strict()).min(1).max(100).refine(items => new Set(items.map(item => item.invocationId)).size === items.length),
  decision: z.literal('waived'),
}).strict()

export type LocalChangeRecoveryItem = DeepReadonly<z.infer<typeof changeRecoveryItemSchema>>
export type ChangeRecoveryListRequest = z.infer<typeof changeRecoveryListRequestSchema>
export type ChangeRecoveryRecheckRequest = z.infer<typeof changeRecoveryRecheckRequestSchema>
export type ChangeRecoveryResolveRequest = z.infer<typeof changeRecoveryResolveRequestSchema>

export const changesRecoveryRpc = {
  list: { method: 'changes.recovery.list', input: changeRecoveryListRequestSchema, response: z.array(changeRecoveryItemSchema) },
  recheck: { method: 'changes.recovery.recheck', input: changeRecoveryRecheckRequestSchema, response: z.array(changeRecoveryItemSchema) },
  resolve: { method: 'changes.recovery.resolve', input: changeRecoveryResolveRequestSchema, response: z.array(changeRecoveryItemSchema) },
} as const satisfies Record<string, RuntimeRequestContract>

export const changeSetChangeNoticeSchema = z.object({
  sourceId: z.uuid(),
  revision: z.number().int().positive(),
  conversationId: idSchema,
  runId: idSchema,
}).strict()

export type ChangeSetChangeNotice = z.infer<typeof changeSetChangeNoticeSchema>
export const changesChanged = { method: 'changes.changed', params: changeSetChangeNoticeSchema } as const
