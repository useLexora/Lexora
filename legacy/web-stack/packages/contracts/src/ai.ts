import { z } from 'zod'
import {
  AI_DEFAULT_MODEL_STATUS_VALUES,
  AI_MODEL_CAPABILITY_VALUES,
  AI_MODEL_INTENT_KEY_VALUES,
  AI_MODEL_MODALITY_VALUES,
  AI_MODEL_TYPE_VALUES,
  AI_PROVIDER_AUTH_MODE_VALUES,
  AI_PROVIDER_CREDENTIAL_STATUS_VALUES,
  AI_PROVIDER_ENDPOINT_MODE_VALUES,
  AI_PROVIDER_SCOPE_VALUES,
  AI_PROVIDER_SOURCE_VALUES,
} from './ai/constants'

export {
  AI_DEFAULT_MODEL_STATUS,
  AI_DEFAULT_MODEL_STATUS_VALUES,
  AI_MODEL_CAPABILITY,
  AI_MODEL_CAPABILITY_VALUES,
  AI_MODEL_INTENT_DEFINITIONS,
  AI_MODEL_INTENT_KEY,
  AI_MODEL_INTENT_KEY_VALUES,
  AI_MODEL_MODALITY,
  AI_MODEL_MODALITY_VALUES,
  AI_MODEL_TYPE,
  AI_MODEL_TYPE_VALUES,
  AI_PROVIDER_AUTH_MODE,
  AI_PROVIDER_AUTH_MODE_VALUES,
  AI_PROVIDER_CREDENTIAL_STATUS,
  AI_PROVIDER_CREDENTIAL_STATUS_VALUES,
  AI_PROVIDER_ENDPOINT_MODE,
  AI_PROVIDER_ENDPOINT_MODE_VALUES,
  AI_PROVIDER_SCOPE,
  AI_PROVIDER_SCOPE_VALUES,
  AI_PROVIDER_SOURCE,
  AI_PROVIDER_SOURCE_VALUES,
} from './ai/constants'

export const AiProviderScopeSchema = z.enum(AI_PROVIDER_SCOPE_VALUES)
export const AiProviderEndpointModeSchema = z.enum(AI_PROVIDER_ENDPOINT_MODE_VALUES)
export const AiProviderAuthModeSchema = z.enum(AI_PROVIDER_AUTH_MODE_VALUES)
export const AiProviderSourceSchema = z.enum(AI_PROVIDER_SOURCE_VALUES)
export const AiModelTypeSchema = z.enum(AI_MODEL_TYPE_VALUES)
export const AiModelModalitySchema = z.enum(AI_MODEL_MODALITY_VALUES)
export const AiModelCapabilitySchema = z.enum(AI_MODEL_CAPABILITY_VALUES)
export const AiModelIntentKeySchema = z.enum(AI_MODEL_INTENT_KEY_VALUES)
export const AiProviderCredentialStatusSchema = z.enum(AI_PROVIDER_CREDENTIAL_STATUS_VALUES)
export const AiDefaultModelStatusSchema = z.enum(AI_DEFAULT_MODEL_STATUS_VALUES)

const IsoDateTimeStringSchema = z.string().datetime()
const NonEmptyStringSchema = z.string().trim().min(1)
const OptionalLimitSchema = z.number().int().positive().nullable()

export const AiModelRefSchema = z.object({
  providerId: NonEmptyStringSchema,
  scope: AiProviderScopeSchema,
  providerKey: NonEmptyStringSchema,
  modelId: NonEmptyStringSchema,
}).strict()

export const AiProviderPresetSchema = z.object({
  providerKey: NonEmptyStringSchema,
  providerName: NonEmptyStringSchema,
  adapterKey: NonEmptyStringSchema,
  endpointMode: AiProviderEndpointModeSchema,
  authMode: AiProviderAuthModeSchema,
  supportedModelTypes: z.array(AiModelTypeSchema),
  fixedEndpoint: z.string().trim().url().nullable().optional(),
}).strict()

export const AiProviderPresetsResponseSchema = z.object({
  presets: z.array(AiProviderPresetSchema),
}).strict()

export const AiProviderSchema = z.object({
  providerId: NonEmptyStringSchema,
  scope: AiProviderScopeSchema,
  source: AiProviderSourceSchema,
  providerKey: NonEmptyStringSchema,
  providerName: NonEmptyStringSchema,
  adapterKey: NonEmptyStringSchema,
  endpointMode: AiProviderEndpointModeSchema,
  authMode: AiProviderAuthModeSchema,
  endpointEditable: z.boolean(),
  nameEditable: z.boolean(),
  deletable: z.boolean(),
  endpoint: z.string().trim().min(1).nullable(),
  credentialStatus: AiProviderCredentialStatusSchema,
  enabled: z.boolean(),
  modelCount: z.number().int().nonnegative(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
}).strict()

export const AiProviderCredentialSchema = z.object({
  apiKey: z.string().nullable(),
}).strict()

export const AiProviderModelItemSchema = z.object({
  providerId: NonEmptyStringSchema,
  modelId: NonEmptyStringSchema,
  modelName: NonEmptyStringSchema,
  modelType: AiModelTypeSchema,
  inputModalities: z.array(AiModelModalitySchema),
  outputModalities: z.array(AiModelModalitySchema),
  capabilities: z.array(AiModelCapabilitySchema),
  contextWindow: OptionalLimitSchema,
  maxOutputTokens: OptionalLimitSchema,
  enabled: z.boolean().optional(),
  updatedAt: IsoDateTimeStringSchema.optional(),
}).strict()

export const AiProviderModelsSchema = z.object({
  models: z.array(AiProviderModelItemSchema),
}).strict()

export const AiAvailableModelOptionSchema = z.object({
  providerId: NonEmptyStringSchema,
  scope: AiProviderScopeSchema,
  providerKey: NonEmptyStringSchema,
  providerName: NonEmptyStringSchema,
  modelId: NonEmptyStringSchema,
  modelName: NonEmptyStringSchema,
  modelType: AiModelTypeSchema,
  inputModalities: z.array(AiModelModalitySchema),
  outputModalities: z.array(AiModelModalitySchema),
  capabilities: z.array(AiModelCapabilitySchema),
  selectable: z.boolean(),
  unavailableReason: z.string().trim().min(1).nullable(),
}).strict()

export const AiAvailableProviderOptionSchema = z.object({
  providerId: NonEmptyStringSchema,
  scope: AiProviderScopeSchema,
  providerKey: NonEmptyStringSchema,
  providerName: NonEmptyStringSchema,
}).strict()

export const AiDefaultModelPolicyItemSchema = z.object({
  intentKey: AiModelIntentKeySchema,
  modelRef: AiModelRefSchema.nullable(),
  status: AiDefaultModelStatusSchema,
  invalidReason: z.string().trim().min(1).nullable(),
  updatedAt: IsoDateTimeStringSchema.nullable(),
}).strict()

export const UpdateAiDefaultModelPolicyRequestSchema = z.object({
  modelRef: AiModelRefSchema.pick({
    providerId: true,
    modelId: true,
  }).nullable(),
}).strict()

export type AiProviderScope = z.infer<typeof AiProviderScopeSchema>
export type AiProviderEndpointMode = z.infer<typeof AiProviderEndpointModeSchema>
export type AiProviderAuthMode = z.infer<typeof AiProviderAuthModeSchema>
export type AiProviderSource = z.infer<typeof AiProviderSourceSchema>
export type AiModelType = z.infer<typeof AiModelTypeSchema>
export type AiModelModality = z.infer<typeof AiModelModalitySchema>
export type AiModelCapability = z.infer<typeof AiModelCapabilitySchema>
export type AiModelIntentKey = z.infer<typeof AiModelIntentKeySchema>

export type AiModelRef = z.infer<typeof AiModelRefSchema>
export type AiProviderPreset = z.infer<typeof AiProviderPresetSchema>
export type AiProvider = z.infer<typeof AiProviderSchema>
export type AiProviderCredential = z.infer<typeof AiProviderCredentialSchema>
export type AiProviderModelItem = z.infer<typeof AiProviderModelItemSchema>
export type AiProviderModels = z.infer<typeof AiProviderModelsSchema>
export type AiAvailableModelOption = z.infer<typeof AiAvailableModelOptionSchema>
export type AiAvailableProviderOption = z.infer<typeof AiAvailableProviderOptionSchema>
export type AiDefaultModelPolicyItem = z.infer<typeof AiDefaultModelPolicyItemSchema>
export type UpdateAiDefaultModelPolicyRequest = z.infer<typeof UpdateAiDefaultModelPolicyRequestSchema>
