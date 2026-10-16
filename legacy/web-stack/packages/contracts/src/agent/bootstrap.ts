import { z } from 'zod'
import { AgentChatRuntimeContextSchema } from './chat'
import { ChatGenerationModelTargetSnapshotSchema } from './model'
import { AgentProfileSnapshotSchema } from './profile'
import { AgentRuntimeModelTargetSchema } from './runtime'
import { AgentRuntimeSkillContextSchema, AgentRuntimeSkillCredentialsSchema } from './skill'

const NonEmptyStringSchema = z.string().trim().min(1)

export const ChatGenerationBootstrapSchema = z.object({
  generation: z.object({
    generationId: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    assistantMessageId: NonEmptyStringSchema,
    triggerUserMessageId: NonEmptyStringSchema,
    actorUserId: NonEmptyStringSchema,
    attempt: z.number().int().nonnegative(),
  }).strict(),
  agentProfile: AgentProfileSnapshotSchema,
  model: ChatGenerationModelTargetSnapshotSchema,
  runtimeModelTarget: AgentRuntimeModelTargetSchema,
  context: AgentChatRuntimeContextSchema,
  skills: AgentRuntimeSkillContextSchema,
  skillCredentials: AgentRuntimeSkillCredentialsSchema,
}).strict()

export type ChatGenerationBootstrap = z.infer<typeof ChatGenerationBootstrapSchema>
