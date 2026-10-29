import { z } from 'zod'
import { speechKindSchema } from '../speech/speechApi'
import { providerHeaderNameSchema, providerHeaderValueSchema } from './providerHeaders'
import { providerBaseUrlSchema } from './providerInput'

export const providerSpeechModelSchema = z.object({
  providerId: z.string().min(1).max(160),
  modelId: z.string().trim().min(1).max(200),
  kind: speechKindSchema,
  api: z.literal('openai-audio'),
}).strict()
export type ProviderSpeechModel = z.infer<typeof providerSpeechModelSchema>
export const providerSpeechConnectionSchema = providerSpeechModelSchema.extend({
  displayName: z.string().optional(),
  modelEnabled: z.boolean().default(true),
  available: z.boolean().default(true),
  providerName: z.string(),
  baseUrl: providerBaseUrlSchema,
  enabled: z.boolean(),
  revision: z.string(),
}).strict()
export type ProviderSpeechConnection = z.infer<typeof providerSpeechConnectionSchema>
export const providerSpeechRequestSchema = z.object({
  baseUrl: providerBaseUrlSchema,
  headers: z.record(providerHeaderNameSchema, providerHeaderValueSchema),
}).strict()
export type ProviderSpeechRequest = z.infer<typeof providerSpeechRequestSchema>
export const providerSpeechRpc = {
  list: { method: 'providers.speech.list', input: z.object({}).strict(), response: providerSpeechConnectionSchema.array() },
  prepare: { method: 'providers.speech.prepare', input: providerSpeechModelSchema.extend({ revision: z.string() }).strict(), response: z.discriminatedUnion('status', [
    z.object({ status: z.literal('ready'), request: providerSpeechRequestSchema }).strict(),
    z.object({ status: z.literal('error'), code: z.enum(['SPEECH_PROVIDER_UNAVAILABLE', 'SPEECH_SERVICE_UNAUTHORIZED']) }).strict(),
  ]) },
} as const
export const PROVIDER_SPEECH_SETTINGS_KEY = 'buddy.providers.speech'
