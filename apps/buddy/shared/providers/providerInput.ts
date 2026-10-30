import type { ProviderModelType } from './providerModelType'
import { z } from 'zod'
import { BUDDY_THINKING_LEVELS } from '../conversation/modelSelection'
import { isHttpEndpointUrl } from '../network/networkSecurity'
import { modelCatalogReferenceSchema } from './providerCatalog'
import { providerRequestHeadersSchema } from './providerHeaders'
import { providerModelTypeSchema } from './providerModelType'

export const DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW = 128_000

export const DEFAULT_CUSTOM_MODEL_MAX_TOKENS = 16_384

export const providerDisplayNameSchema = z.string().trim().min(1).max(100)

export const providerBaseUrlSchema = z.url().refine(isHttpEndpointUrl)

const thinkingLevelMapSchema = z.partialRecord(
  z.enum(BUDDY_THINKING_LEVELS),
  z.string().nullable(),
)

const modelCostRatesSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
}).strict()

const storedModelCostSchema = modelCostRatesSchema.extend({
  tiers: z.array(modelCostRatesSchema.extend({
    inputTokensAbove: z.number().nonnegative(),
  }).strict()).optional(),
}).strict()

const customProviderModelBaseSchema = z.object({
  type: providerModelTypeSchema.default('chat'),
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200).optional(),
  reasoning: z.boolean().default(false),
  input: z.array(z.enum(['text', 'image'])).min(1).default(['text']),
  cost: modelCostRatesSchema.default({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
  contextWindow: z.number().int().positive().nullish(),
  maxTokens: z.number().int().positive().nullish(),
}).strict()

function withCustomModelDefaults<T extends {
  type: ProviderModelType
  contextWindow?: number | null
  id: string
  maxTokens?: number | null
  name?: string
}>(model: T) {
  return {
    ...model,
    contextWindow: model.type === 'chat' ? model.contextWindow ?? DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW : null,
    maxTokens: model.type === 'chat' ? model.maxTokens ?? DEFAULT_CUSTOM_MODEL_MAX_TOKENS : null,
    name: model.name ?? model.id,
  }
}

export const customProviderModelSchema = customProviderModelBaseSchema.transform(withCustomModelDefaults)

export const storedCustomProviderModelSchema = customProviderModelBaseSchema.extend({
  catalogProviderId: z.string().trim().min(1).optional(),
  catalogModelId: z.string().trim().min(1).optional(),
  catalogSelection: modelCatalogReferenceSchema.optional(),
  compat: z.record(z.string(), z.unknown()).optional(),
  cost: storedModelCostSchema.default({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
  samplingParams: z.record(z.string(), z.unknown()).optional(),
  source: z.enum(['manual', 'synced']).optional(),
  thinkingLevelMap: thinkingLevelMapSchema.optional(),
}).strict().transform(withCustomModelDefaults)

export const customProviderInputSchema = z.object({
  requestHeaders: providerRequestHeadersSchema.optional(),
  id: z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/),
  displayName: providerDisplayNameSchema,
  description: z.string().trim().max(200).optional(),
  api: z.enum([
    'anthropic-messages',
    'azure-openai-responses',
    'bedrock-converse-stream',
    'google-generative-ai',
    'google-vertex',
    'mistral-conversations',
    'openai-codex-responses',
    'openai-completions',
    'openai-responses',
    'pi-messages',
  ]),
  baseUrl: providerBaseUrlSchema,
  models: z.array(customProviderModelSchema).default([]),
  enabled: z.boolean().default(false),
}).strict().superRefine((provider, context) => {
  const modelIds = new Set<string>()
  for (const [index, model] of provider.models.entries()) {
    if (modelIds.has(model.id)) {
      context.addIssue({
        code: 'custom',
        message: 'Model identifiers must be unique within a provider',
        path: ['models', index, 'id'],
      })
    }
    modelIds.add(model.id)
    if (model.maxTokens !== null && model.contextWindow !== null && model.maxTokens > model.contextWindow) {
      context.addIssue({
        code: 'custom',
        message: 'Model max tokens cannot exceed its context window',
        path: ['models', index, 'maxTokens'],
      })
    }
  }
})

export const defaultModelSchema = z.object({
  modelId: z.string().min(1),
  providerId: z.string().min(1),
  reasoning: z.enum(BUDDY_THINKING_LEVELS).nullable(),
}).strict()

export const providerModelInputSchema = customProviderModelSchema

export type CustomProviderInput = z.input<typeof customProviderInputSchema>

export type ParsedCustomProviderInput = z.output<typeof customProviderInputSchema>

export type BuddyDefaultModel = z.infer<typeof defaultModelSchema>

export type ProviderModelInput = z.input<typeof providerModelInputSchema>
