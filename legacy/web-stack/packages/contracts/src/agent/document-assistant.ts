import { z } from 'zod'

export const AGENT_DOCUMENT_ASSISTANT_SKILL_KEY = 'lexora.document-assistant' as const
export const AGENT_DOCUMENT_ASSISTANT_ANCHOR_CONTEXT_MAX_LENGTH = 24_000
export const AGENT_DOCUMENT_ASSISTANT_REFUSAL_PREFIX = '无法生成候选：' as const

export const AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT = {
  REWRITE_SELECTION: 'rewrite_selection',
  CONTINUE_AT_ANCHOR: 'continue_at_anchor',
} as const

export const AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT_VALUES = [
  AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.REWRITE_SELECTION,
  AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR,
] as const

export const AgentDocumentAssistantEditIntentSchema = z.enum(AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT_VALUES)

export const AgentDocumentAssistantSkillInvocationSchema = z.object({
  skillKey: z.literal(AGENT_DOCUMENT_ASSISTANT_SKILL_KEY),
  intent: AgentDocumentAssistantEditIntentSchema,
}).strict()

export const AGENT_DOCUMENT_ASSISTANT_SKILL_MANIFEST = {
  title: '文档助手',
  description: '基于当前文档或选区生成续写、重写等候选修改，由用户确认后再写入文档。',
  tools: [],
} as const

export type AgentDocumentAssistantEditIntent = z.infer<typeof AgentDocumentAssistantEditIntentSchema>
export type AgentDocumentAssistantSkillInvocation = z.infer<typeof AgentDocumentAssistantSkillInvocationSchema>
