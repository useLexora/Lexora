import { z } from 'zod'
import {
  AiModelCapabilitySchema,
  AiProviderAuthModeSchema,
  AiProviderScopeSchema,
} from '../ai'

const NonEmptyStringSchema = z.string().trim().min(1)

export const AgentSkillRuntimeInputsSchema = z.record(
  NonEmptyStringSchema,
  z.record(z.string(), z.unknown()),
).default({})

export const AgentRuntimeHintsSchema = z.object({
  skillInputs: AgentSkillRuntimeInputsSchema,
}).strict().default({
  skillInputs: {},
})

export const AgentRuntimeModelTargetSchema = z.object({
  providerId: NonEmptyStringSchema,
  scope: AiProviderScopeSchema,
  providerKey: NonEmptyStringSchema,
  adapterKey: NonEmptyStringSchema,
  endpoint: NonEmptyStringSchema,
  apiKey: NonEmptyStringSchema.nullable(),
  authMode: AiProviderAuthModeSchema,
  modelId: NonEmptyStringSchema,
  capabilities: z.array(AiModelCapabilitySchema),
}).strict()

export type AgentSkillRuntimeInputs = z.infer<typeof AgentSkillRuntimeInputsSchema>
export type AgentRuntimeHints = z.infer<typeof AgentRuntimeHintsSchema>
export type AgentRuntimeModelTarget = z.infer<typeof AgentRuntimeModelTargetSchema>
