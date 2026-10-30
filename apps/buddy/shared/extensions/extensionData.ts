import type { EventSnapshot } from '../events/eventTypes'
import { z } from 'zod'
import { taskMetricsSchema } from '../runs/taskMetricsApi.ts'

export const extensionDataSourceSchema = z.enum(['task.metrics', 'context.usage'])
export type ExtensionDataSource = z.infer<typeof extensionDataSourceSchema>

export const extensionDataQuerySchema = z.object({
  source: extensionDataSourceSchema,
  scope: z.literal('bound'),
}).strict()
export interface ExtensionDataQuery<Source extends ExtensionDataSource = ExtensionDataSource> {
  readonly source: Source
  readonly scope: 'bound'
}

export const extensionTaskMetricsDataSchema = taskMetricsSchema.pick({
  branchId: true,
  turns: true,
  steps: true,
  tokens: true,
  throughput: true,
}).extend({ taskId: z.string().min(1) }).strict()

export const extensionContextUsageDataSchema = z.object({
  taskId: z.string().min(1),
  branchId: z.string().min(1),
  actorId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  tokens: z.number().nonnegative(),
  window: z.number().positive(),
  percent: z.number().nonnegative(),
}).strict()

export interface ExtensionDataValues {
  'task.metrics': z.infer<typeof extensionTaskMetricsDataSchema>
  'context.usage': z.infer<typeof extensionContextUsageDataSchema>
}
export type ExtensionDataSnapshot<Source extends ExtensionDataSource = ExtensionDataSource> = {
  [Key in Source]: {
    readonly source: Key
    readonly status: 'ready'
    readonly value: EventSnapshot<ExtensionDataValues[Key]>
  } | {
    readonly source: Key
    readonly status: 'denied' | 'no_target' | 'unavailable'
    readonly value: null
  }
}[Source]

function sourceSnapshotSchema<Source extends ExtensionDataSource, Value extends z.ZodType>(source: Source, value: Value) {
  return z.discriminatedUnion('status', [
    z.object({ source: z.literal(source), status: z.literal('ready'), value }).strict(),
    z.object({ source: z.literal(source), status: z.enum(['denied', 'no_target', 'unavailable']), value: z.null() }).strict(),
  ])
}
export const extensionDataSnapshotSchema = z.union([
  sourceSnapshotSchema('task.metrics', extensionTaskMetricsDataSchema),
  sourceSnapshotSchema('context.usage', extensionContextUsageDataSchema),
])

export const extensionDataReadRequestSchema = extensionDataQuerySchema
export const extensionDataObserveRequestSchema = z.object({
  id: z.string().uuid(),
  query: extensionDataQuerySchema,
}).strict()
export const extensionDataUnobserveRequestSchema = z.object({ id: z.string().uuid() }).strict()
export type ExtensionDataReadRequest = z.infer<typeof extensionDataReadRequestSchema>
export type ExtensionDataObserveRequest = z.infer<typeof extensionDataObserveRequestSchema>
export type ExtensionDataUnobserveRequest = z.infer<typeof extensionDataUnobserveRequestSchema>
export const extensionDataRequestSchemas = {
  'data.read': extensionDataReadRequestSchema,
  'data.observe': extensionDataObserveRequestSchema,
  'data.unobserve': extensionDataUnobserveRequestSchema,
} as const

export function projectExtensionDataSnapshot(snapshot: ExtensionDataSnapshot, sources: readonly ExtensionDataSource[] = []): ExtensionDataSnapshot {
  return sources.includes(snapshot.source) ? snapshot : { source: snapshot.source, status: 'denied', value: null }
}
