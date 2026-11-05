import { z } from 'zod'
import { BUDDY_THINKING_LEVELS } from '../conversation/modelSelection.ts'
import { inferenceHashSchema, inferenceModelSchema, inferenceProviderNameSchema } from './extensionInference'
import { extensionIdSchema } from './extensionManifest'

export const extensionModelSchema = inferenceModelSchema.safeExtend({
  extensionId: extensionIdSchema,
  extensionName: z.string(),
  providerName: inferenceProviderNameSchema.optional(),
  generation: z.uuid(),
  revision: inferenceHashSchema,
  bindingRevision: inferenceHashSchema,
  managementPage: z.boolean(),
}).strict()
export type ExtensionModel = z.infer<typeof extensionModelSchema>
export const pluginProviderPrefix = 'plugin:'
export const pluginProviderId = (extensionId: string) => `${pluginProviderPrefix}${extensionId}`
export const pluginChatApi = 'lexora-plugin-chat'
export const extensionChatRpc = { list: 'extensions.models.list', changed: 'extensions.models.changed', invoke: 'extensions.models.invoke', event: 'extensions.models.event' } as const

const toolCallSchema = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(128), arguments: z.record(z.string(), z.json()) }).strict()
export const extensionChatMaxBytes = 32 * 1024 * 1024
const contentSchema = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({
    type: z.literal('image'),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.string().min(4).max(extensionChatMaxBytes).regex(/^[a-z0-9+/]+={0,2}$/i).refine(value => value.length % 4 === 0, 'Expected padded base64'),
  }).strict(),
])).min(1)
const toolResultShape = { role: z.literal('tool'), toolCallId: z.string(), name: z.string(), isError: z.boolean() }
export const extensionChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.union([
    z.object({ role: z.literal('system'), text: z.string() }).strict(),
    z.object({ role: z.literal('user'), text: z.string() }).strict(),
    z.object({ role: z.literal('user'), content: contentSchema }).strict(),
    z.object({ role: z.literal('assistant'), text: z.string(), toolCalls: z.array(toolCallSchema) }).strict(),
    z.object({ ...toolResultShape, text: z.string() }).strict(),
    z.object({ ...toolResultShape, content: contentSchema }).strict(),
  ])),
  tools: z.array(z.object({ name: z.string(), description: z.string(), parameters: z.record(z.string(), z.json()) }).strict()).max(256),
  maxTokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2).optional(),
  reasoning: z.enum(BUDDY_THINKING_LEVELS).optional(),
}).strict()
export type ExtensionChatRequest = z.infer<typeof extensionChatRequestSchema>
export const extensionChatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thinking'), text: z.string().max(16000) }).strict(),
  z.object({ type: z.literal('text'), text: z.string().max(16000) }).strict(),
  z.object({ type: z.literal('tool'), call: toolCallSchema }).strict(),
  z.object({ type: z.literal('done'), reason: z.enum(['stop', 'length', 'toolUse']), usage: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), cacheRead: z.number().int().nonnegative().default(0), cacheWrite: z.number().int().nonnegative().default(0) }).strict() }).strict(),
])
export type ExtensionChatEvent = z.infer<typeof extensionChatEventSchema>
export const extensionChatCapabilitiesSchema = z.object({ toolCall: z.boolean(), image: z.boolean() }).strict()
export type ExtensionChatCapabilities = z.infer<typeof extensionChatCapabilitiesSchema>
export const extensionChatInvocationSchema = z.object({
  id: z.uuid(),
  target: extensionModelSchema,
  capabilities: extensionChatCapabilitiesSchema,
  parentInvocationId: z.uuid().optional(),
  request: extensionChatRequestSchema,
}).strict()
