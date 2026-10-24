import type { EventSnapshot } from '../events/eventTypes'
import { z } from 'zod'
import { taskActionEventSchema } from '../conversation/taskEvents.ts'
import { extensionAgentMethodSchema } from './extensionAgentCapabilities.ts'
import { extensionConditionReferenceSchema } from './extensionConditions.ts'
import { extensionSettingIdSchema, extensionSettingKeySchema } from './extensionSettings.ts'
import { extensionToolInputSchema, extensionToolParametersSchema } from './extensionToolParameters.ts'

export const extensionAgentRpc = {
  list: 'extensions.agent.list',
  invoke: 'extensions.agent.invoke',
  request: 'extensions.agent.request',
  changed: 'extensions.agent.changed',
  resource: 'extensions.agent.resource',
} as const
export const extensionAgentInvocationLimits = {
  concurrent: 32,
  concurrentPerExtension: 4,
  queued: 1024,
} as const
export const extensionToolSchema = z.object({
  id: extensionSettingIdSchema,
  title: z.string().min(1).max(100),
  description: z.string().min(1).max(4000),
  access: z.enum(['read', 'write']).optional(),
  parameters: extensionToolParametersSchema,
}).strict()
export const extensionActionTriggerSchema = z.enum(['task:created', 'task:input:committed', 'task:run:before', 'task:reply:started', 'task:turn:completed', 'user'])
export const extensionActionSchema = z.object({
  enabledWhen: extensionConditionReferenceSchema.optional(),
  id: extensionSettingIdSchema,
  title: z.string().min(1).max(100),
  triggers: z.array(extensionActionTriggerSchema).min(1).max(6).refine(value => new Set(value).size === value.length),
  execution: z.enum(['background', 'blocking']).optional(),
}).strict().refine(action => action.execution !== 'blocking' || action.triggers.every(trigger => trigger === 'task:run:before'), { message: 'Only pre-run hooks may block execution' })
export const extensionActionResultSchema = z.object({ status: z.enum(['completed', 'skipped']), message: z.string().max(500).optional() }).strict()
export const extensionActionCauseSchema = z.union([taskActionEventSchema, z.object({ type: z.literal('user') }).strict()])
export type ExtensionActionCause = EventSnapshot<z.infer<typeof extensionActionCauseSchema>>
export type ExtensionActionTrigger = z.infer<typeof extensionActionTriggerSchema>
export const extensionAgentSchema = z.object({
  enabledWhen: z.union([extensionSettingKeySchema, extensionConditionReferenceSchema]).optional(),
  instructions: z.string().max(8000).default(''),
  tools: z.array(extensionToolSchema).max(16).default([]),
  actions: z.array(extensionActionSchema).max(16).default([]),
}).strict().refine(value => value.tools.length + value.actions.length > 0)
export const extensionAgentDescriptorSchema = z.object({
  id: z.string(),
  name: z.string(),
  revision: z.string(),
  configurationRevision: z.string(),
  agent: extensionAgentSchema,
}).strict()
export type ExtensionAgentDescriptor = z.infer<typeof extensionAgentDescriptorSchema>
export const extensionAgentCatalogSchema = z.array(extensionAgentDescriptorSchema.pick({ id: true, revision: true, configurationRevision: true }))
export type ExtensionAgentCatalog = z.infer<typeof extensionAgentCatalogSchema>
const invocationIdentity = {
  context: z.object({ taskId: z.string(), runId: z.string().nullable() }).strict().optional(),
  extensionId: z.string(),
  revision: z.string(),
  configurationRevision: z.string(),
  invocationId: z.string().uuid(),
}
export const extensionAgentInvocationSchema = z.union([z.object({
  ...invocationIdentity,
  tool: z.string().max(180),
  input: extensionToolInputSchema,
}).strict(), z.object({
  ...invocationIdentity,
  action: z.string().max(180),
  cause: extensionActionCauseSchema,
}).strict()])
export type ExtensionAgentInvocation = z.infer<typeof extensionAgentInvocationSchema>
export const extensionAgentRequestSchema = z.object({
  invocationId: z.string().uuid(),
  method: extensionAgentMethodSchema,
  params: z.json(),
}).strict()
