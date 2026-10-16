import { z } from 'zod'
import {
  AiModelCapabilitySchema,
  AiModelModalitySchema,
  AiModelTypeSchema,
  AiProviderAuthModeSchema,
  AiProviderScopeSchema,
} from '../ai'

const NonEmptyStringSchema = z.string().trim().min(1)

export const ChatGenerationModelTargetSnapshotSchema = z.object({
  providerId: NonEmptyStringSchema,
  scope: AiProviderScopeSchema,
  providerKey: NonEmptyStringSchema,
  adapterKey: NonEmptyStringSchema,
  endpoint: NonEmptyStringSchema,
  authMode: AiProviderAuthModeSchema,
  modelId: NonEmptyStringSchema,
  modelName: NonEmptyStringSchema,
  modelType: AiModelTypeSchema,
  inputModalities: z.array(AiModelModalitySchema),
  outputModalities: z.array(AiModelModalitySchema),
  capabilities: z.array(AiModelCapabilitySchema),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
}).strict()

export const AgentModelPolicySchema = z.object({
  selectionMode: z.enum(['user_default', 'fixed_model']).default('user_default'),
  providerId: NonEmptyStringSchema.optional(),
  modelId: NonEmptyStringSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
}).strict()

export type ChatGenerationModelTargetSnapshot = z.infer<typeof ChatGenerationModelTargetSnapshotSchema>
export type AgentModelPolicy = z.infer<typeof AgentModelPolicySchema>
