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
}).strict()

export const changeSetDetailSchema = changeSetSummarySchema.extend({
  files: z.array(fileChangeDetailSchema).max(512),
}).strict()

export type LocalChangeSetDetail = DeepReadonly<z.infer<typeof changeSetDetailSchema>>

export type LocalChangeSetSummary = DeepReadonly<z.infer<typeof changeSetSummarySchema>>

export type LocalFileChangeDetail = DeepReadonly<z.infer<typeof fileChangeDetailSchema>>

export const changeOverviewSchema = z.object({
  coverage: z.enum(['complete', 'partial']),
  files: z.array(fileChangeDetailSchema).max(4096),
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

export const changeSetChangeNoticeSchema = z.object({
  sourceId: z.uuid(),
  revision: z.number().int().positive(),
  conversationId: idSchema,
  runId: idSchema,
}).strict()

export type ChangeSetChangeNotice = z.infer<typeof changeSetChangeNoticeSchema>
export const changesChanged = { method: 'changes.changed', params: changeSetChangeNoticeSchema } as const
