import { z } from 'zod'
import { BUDDY_DOCUMENT_MIME_TYPES } from '../../../shared/conversation/attachmentFormats'
import { BUDDY_THINKING_LEVELS } from '../../../shared/conversation/modelSelection'
import { modelCapabilitiesSchema, modelCapabilityOverridesSchema } from '../../../shared/providers/providerCapabilities'
import { modelCatalogResolutionSchema } from '../../../shared/providers/providerCatalog'
import { providerRequestHeadersSchema } from '../../../shared/providers/providerHeaders'
import { providerModelTypeSchema } from '../../../shared/providers/providerModelType'

export const apiKeyCredentialSchema = z.object({
  type: z.literal('api_key'),
  key: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict()

export const oauthCredentialSchema = z.object({
  type: z.literal('oauth'),
  access: z.string(),
  refresh: z.string(),
  expires: z.number(),
}).loose()

export const credentialSchema = z.union([
  apiKeyCredentialSchema,
  oauthCredentialSchema,
])

export const buddyProviderSchema = z.object({
  plugin: z.object({ id: z.string(), managementPage: z.boolean() }).strict().optional(),
  requestHeaders: providerRequestHeadersSchema.default([]),
  activeRunCount: z.number().int().nonnegative(),
  added: z.boolean(),
  api: z.string().nullable(),
  id: z.string(),
  displayName: z.string(),
  description: z.string().max(200).nullable(),
  baseUrl: z.string().nullable(),
  builtinProviderId: z.string().nullable(),
  canSyncModels: z.boolean(),
  authTypes: z.array(z.enum(['api_key', 'oauth'])),
  storedCredentialType: z.enum(['api_key', 'oauth']).nullable(),
  status: z.enum(['available', 'authentication_required', 'unavailable']),
  custom: z.boolean(),
  enabled: z.boolean(),
  enabledModelCount: z.number().int().nonnegative(),
  modelCount: z.number().int().nonnegative(),
  setupComplete: z.boolean(),
  syncUnavailableReason: z.enum(['authentication_required', 'unsupported_api']).nullable(),
}).strict()

export const buddyModelSchema = z.object({
  type: providerModelTypeSchema.default('chat'),
  sourceType: providerModelTypeSchema.default('chat'),
  typeOverride: providerModelTypeSchema.nullable().default(null),
  available: z.boolean(),
  catalogMatch: z.enum(['matched', 'ambiguous', 'unmatched', 'not_applicable']),
  catalog: modelCatalogResolutionSchema,
  metadataKnown: z.boolean(),
  id: z.string(),
  displayName: z.string(),
  providerId: z.string(),
  api: z.string(),
  capabilities: z.array(z.enum(['text', 'image', 'pdf', 'audio', 'video', 'reasoning'])),
  fileInputMimeTypes: z.array(z.enum(BUDDY_DOCUMENT_MIME_TYPES)),
  capabilityOverrides: modelCapabilityOverridesSchema.nullable(),
  sourceCapabilities: modelCapabilitiesSchema,
  reasoningOptions: z.array(z.enum(BUDDY_THINKING_LEVELS)),
  contextWindow: z.number().int().nullable(),
  hasParameterOverride: z.boolean(),
  maxTokens: z.number().int().nullable(),
  overrideContextWindow: z.number().int().positive().nullable(),
  overrideMaxTokens: z.number().int().positive().nullable(),
  enabled: z.boolean(),
  lastSeenAt: z.string().nullable(),
  source: z.enum(['builtin', 'manual', 'synced']),
  sourceContextWindow: z.number().int().positive().nullable(),
  sourceMaxTokens: z.number().int().positive().nullable(),
  sourceParametersUpdated: z.boolean(),
}).strict()

export const modelParametersOverrideSchema = z.object({
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
}).strict().refine(value => value.maxTokens <= value.contextWindow)

export const providerAuthChallengeSchema = z.object({
  challengeId: z.string().uuid(),
  providerId: z.string(),
  type: z.enum([
    'auth_url',
    'device_code',
    'info',
    'manual_code',
    'progress',
    'secret',
    'select',
    'text',
  ]),
  message: z.string().optional(),
  placeholder: z.string().optional(),
  url: z.string().optional(),
  instructions: z.string().optional(),
  userCode: z.string().optional(),
  verificationUri: z.string().optional(),
  intervalSeconds: z.number().optional(),
  expiresInSeconds: z.number().optional(),
  options: z.array(z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
  }).strict()).optional(),
  links: z.array(z.object({
    url: z.string(),
    label: z.string().optional(),
  }).strict()).optional(),
}).strict()

export type BuddyProvider = z.infer<typeof buddyProviderSchema>
export type BuddyModel = z.infer<typeof buddyModelSchema>

export type ModelParametersOverride = z.infer<typeof modelParametersOverrideSchema>
export type ProviderAuthChallenge = z.infer<typeof providerAuthChallengeSchema>
