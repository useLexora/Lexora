import { z } from 'zod'
import { extensionAgentMethodSchema } from './extensionAgentCapabilities'
import { extensionSettingIdSchema, extensionSettingKeySchema } from './extensionSettings'

export const extensionAgentRpc = {
  list: 'extensions.agent.list',
  invoke: 'extensions.agent.invoke',
  request: 'extensions.agent.request',
  changed: 'extensions.agent.changed',
} as const
export const extensionToolSchema = z.object({
  id: extensionSettingIdSchema,
  title: z.string().min(1).max(100),
  description: z.string().min(1).max(4000),
  parameters: z.object({
    type: z.literal('object'),
    properties: z.record(z.string().max(80).regex(/^[a-z][a-zA-Z0-9]*$/), z.object({ type: z.enum(['string', 'number', 'boolean']), description: z.string().max(1000).optional() }).strict()).refine(value => Object.keys(value).length <= 16),
    required: z.array(z.string()).max(16).default([]),
    additionalProperties: z.literal(false).default(false),
  }).strict().refine(value => value.required.every(key => Object.hasOwn(value.properties, key))),
}).strict()
export const extensionAgentSchema = z.object({
  enabledWhen: extensionSettingKeySchema.optional(),
  instructions: z.string().max(8000).default(''),
  tools: z.array(extensionToolSchema).min(1).max(16),
}).strict()
export const extensionAgentDescriptorSchema = z.object({
  id: z.string(),
  name: z.string(),
  revision: z.string(),
  configurationRevision: z.string(),
  agent: extensionAgentSchema,
}).strict()
export type ExtensionAgentDescriptor = z.infer<typeof extensionAgentDescriptorSchema>
export const extensionAgentInvocationSchema = z.object({
  extensionId: z.string(),
  revision: z.string(),
  configurationRevision: z.string(),
  invocationId: z.string().uuid(),
  tool: z.string().max(180),
  input: z.record(z.string(), z.union([z.string().max(32768), z.number().finite(), z.boolean()])),
}).strict()
export type ExtensionAgentInvocation = z.infer<typeof extensionAgentInvocationSchema>
export const extensionAgentRequestSchema = z.object({
  invocationId: z.string().uuid(),
  method: extensionAgentMethodSchema,
  params: z.json(),
}).strict()
