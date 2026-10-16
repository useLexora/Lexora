import { z } from 'zod'
import { AiModelRefSchema } from '../ai'
import { AgentMemoryPolicySchema } from './memory'
import { AgentModelPolicySchema } from './model'
import { AgentSkillBindingSchema } from './skill'

export { AgentMemoryPolicySchema } from './memory'
export type { AgentMemoryPolicy } from './memory'

const NonEmptyStringSchema = z.string().trim().min(1)

export const AgentProfileInstructionsSchema = z.object({
  systemPrompt: NonEmptyStringSchema,
  responseStyle: z.string().trim().min(1).optional(),
  constraints: z.array(z.string().trim().min(1)).default([]),
  outputPreferences: z.array(z.string().trim().min(1)).default([]),
}).strict()

export const AgentContextPolicySchema = z.object({
  recentMessageLimit: z.number().int().positive().default(20),
  recentUserTurnLimit: z.number().int().positive().default(8),
  olderMessagesExcerptMaxLength: z.number().int().nonnegative().default(2000),
}).strict()

export const AgentToolPolicySchema = z.object({
  enabled: z.boolean().default(true),
}).strict().default({ enabled: true })

export const AgentProfileConfigSchema = z.object({
  schemaVersion: z.literal(1),
  instructions: AgentProfileInstructionsSchema,
  modelPolicy: AgentModelPolicySchema.default({ selectionMode: 'user_default' }),
  contextPolicy: AgentContextPolicySchema.default({
    recentMessageLimit: 20,
    recentUserTurnLimit: 8,
    olderMessagesExcerptMaxLength: 2000,
  }),
  memoryPolicy: AgentMemoryPolicySchema,
  skillBindings: z.array(AgentSkillBindingSchema).default([]),
  toolPolicy: AgentToolPolicySchema,
}).strict()

export const AgentProfileSnapshotSchema = z.object({
  profileId: NonEmptyStringSchema,
  ownerUserId: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  currentConfig: AgentProfileConfigSchema,
  capturedAt: z.string().datetime(),
}).strict()

export const AgentProfileSettingsSchema = z.object({
  profileId: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  description: z.string().trim().min(1).nullable(),
  avatarUrl: z.string().trim().min(1).nullable(),
  modelRef: AiModelRefSchema.pick({
    providerId: true,
    modelId: true,
  }).nullable(),
}).strict()

export const UpdateAgentProfileModelPolicyRequestSchema = z.object({
  modelRef: AiModelRefSchema.pick({
    providerId: true,
    modelId: true,
  }).nullable(),
}).strict()

export type AgentProfileInstructions = z.infer<typeof AgentProfileInstructionsSchema>
export type AgentContextPolicy = z.infer<typeof AgentContextPolicySchema>
export { AgentSkillBindingSchema } from './skill'
export type AgentToolPolicy = z.infer<typeof AgentToolPolicySchema>
export type { AgentSkillBinding } from './skill'
export type AgentProfileConfig = z.infer<typeof AgentProfileConfigSchema>
export type AgentProfileSnapshot = z.infer<typeof AgentProfileSnapshotSchema>
export type AgentProfileSettings = z.infer<typeof AgentProfileSettingsSchema>
export type UpdateAgentProfileModelPolicyRequest = z.infer<typeof UpdateAgentProfileModelPolicyRequestSchema>
