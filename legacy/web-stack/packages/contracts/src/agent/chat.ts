import { z } from 'zod'
import {
  ChatDisabledSkillKeysSchema,
  ChatFileMessageAttachmentSchema,
  ChatImageMessageAttachmentSchema,
  ChatMessageContextSnapshotMetaSchema,
  ChatMessageRoleSchema,
  ChatSkillInvocationSchema,
} from '../chat'
import { ResolvedLanguagePreferenceSchema } from '../user'
import { AgentMemoryRunOptionsSchema } from './memory'
import { AgentRuntimeHintsSchema } from './runtime'

const NonEmptyStringSchema = z.string().trim().min(1)

export const AGENT_CHAT_THREAD_PREFIX = 'chat:'

export const AgentChatContextMessageSchema = z.object({
  id: NonEmptyStringSchema,
  role: ChatMessageRoleSchema,
  content: z.string(),
  skillInvocation: ChatSkillInvocationSchema.nullable().optional(),
}).strict()

export const AgentChatContextSnapshotSchema = ChatMessageContextSnapshotMetaSchema.extend({
  order: z.number().int().nonnegative(),
  content: z.string(),
}).strict()

export const AgentChatInputAttachmentSchema = z.discriminatedUnion('type', [
  ChatImageMessageAttachmentSchema,
  ChatFileMessageAttachmentSchema,
])

export const AgentChatAttachmentContentSchema = z.discriminatedUnion('type', [
  ChatImageMessageAttachmentSchema.extend({
    contentBase64: NonEmptyStringSchema,
  }).strict(),
  ChatFileMessageAttachmentSchema.extend({
    contentBase64: NonEmptyStringSchema,
  }).strict(),
])

export const AgentChatRuntimeContextSchema = z.object({
  sessionId: NonEmptyStringSchema,
  threadId: NonEmptyStringSchema,
  sessionHistoryVersion: z.number().int().min(0),
  activePathKey: NonEmptyStringSchema,
  triggerUserMessageId: NonEmptyStringSchema,
  triggerParentMessageId: NonEmptyStringSchema.nullable(),
  assistantMessageId: NonEmptyStringSchema,
  defaultResponseLanguage: ResolvedLanguagePreferenceSchema,
  messages: z.array(AgentChatContextMessageSchema),
  contextSnapshots: z.array(AgentChatContextSnapshotSchema),
  inputAttachments: z.array(AgentChatInputAttachmentSchema).default([]),
  memory: AgentMemoryRunOptionsSchema,
  disabledSkillKeys: ChatDisabledSkillKeysSchema,
  runtimeHints: AgentRuntimeHintsSchema,
}).strict()

export type AgentChatContextMessage = z.infer<typeof AgentChatContextMessageSchema>
export type AgentChatContextSnapshot = z.infer<typeof AgentChatContextSnapshotSchema>
export type AgentChatInputAttachment = z.infer<typeof AgentChatInputAttachmentSchema>
export type AgentChatAttachmentContent = z.infer<typeof AgentChatAttachmentContentSchema>
export type AgentChatRuntimeContext = z.infer<typeof AgentChatRuntimeContextSchema>
