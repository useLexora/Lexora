import { z } from 'zod'
import { extensionConfigurationSchema, extensionModelSelectionSchema } from './extensionSettings'

const unavailableSchema = z.object({ status: z.enum(['not_requested', 'no_context', 'denied', 'unsupported', 'loading', 'invalid']) }).strict()
const revision = { revision: z.string().max(128) }
const configurationScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('space'), spaceId: z.string() }).strict(),
  z.object({ kind: z.literal('task'), taskId: z.string() }).strict(),
])
export const extensionConditionInvocationScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('settings'), moduleId: z.string(), groupId: z.string() }).strict(),
  z.object({ kind: z.literal('task'), taskId: z.string(), runId: z.string().nullable() }).strict(),
])
export type ExtensionConditionInvocationScope = z.infer<typeof extensionConditionInvocationScopeSchema>
export const extensionConditionModelsSchema = z.union([unavailableSchema, z.object({
  status: z.literal('available'),
  ...revision,
  selection: extensionModelSelectionSchema.nullable(),
  models: z.array(z.object({ providerId: z.string(), modelId: z.string(), name: z.string(), available: z.boolean(), capabilities: z.array(z.string()) }).strict()),
}).strict()])
export const extensionConditionTaskSchema = z.union([unavailableSchema, z.object({
  status: z.literal('available'),
  ...revision,
  id: z.string(),
  spaceId: z.string().nullable(),
  branchId: z.string(),
  title: z.string().nullable(),
  titleSource: z.enum(['fallback', 'generated', 'manual', 'legacy']),
  activity: z.enum(['idle', 'running', 'awaiting_approval']),
  modelSelection: extensionModelSelectionSchema.nullable(),
}).strict()])
export const extensionConditionRuntimeSchema = z.object({ models: extensionConditionModelsSchema, task: extensionConditionTaskSchema }).strict()
export type ExtensionConditionRuntime = z.infer<typeof extensionConditionRuntimeSchema>
export const extensionConditionContextSchema = z.object({
  version: z.literal(1),
  scope: z.object({ key: z.string(), configuration: configurationScopeSchema, invocation: extensionConditionInvocationScopeSchema }).strict(),
  target: z.object({ kind: z.enum(['setting', 'agent', 'action']), id: z.string() }).strict(),
  configuration: z.union([unavailableSchema, z.object({ status: z.literal('available'), ...revision, values: extensionConfigurationSchema, sources: z.record(z.string(), configurationScopeSchema) }).strict()]),
  runtime: extensionConditionRuntimeSchema,
  workbench: z.union([unavailableSchema, z.object({ status: z.literal('available'), ...revision, panes: z.array(z.object({ id: z.string(), active: z.boolean(), visible: z.boolean() }).strict()) }).strict()]),
  form: z.union([unavailableSchema, z.object({ status: z.literal('available'), ...revision, values: extensionConfigurationSchema, dirtyKeys: z.array(z.string()) }).strict()]),
}).strict()
export type ExtensionConditionContext = z.infer<typeof extensionConditionContextSchema>
export const extensionConditionSnapshotRpc = {
  method: 'extensions.conditions.snapshot',
  input: z.object({ models: z.boolean(), task: z.boolean(), taskId: z.string().nullable(), runId: z.string().nullable() }).strict(),
  response: extensionConditionRuntimeSchema,
} as const
