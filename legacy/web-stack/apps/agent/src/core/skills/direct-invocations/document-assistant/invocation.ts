import type {
  AgentChatContextMessage,
  AgentChatContextSnapshot,
  AgentDocumentAssistantSkillInvocation,
  AgentRuntimeSkillContext,
} from '@haohaoxue/lexora-contracts'
import {
  AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT,
  AGENT_DOCUMENT_ASSISTANT_SKILL_KEY,
} from '@haohaoxue/lexora-contracts'

export interface DirectDocumentAssistantInvocation {
  contextSnapshotIds: string[]
  skillKey: typeof AGENT_DOCUMENT_ASSISTANT_SKILL_KEY
  intent: AgentDocumentAssistantSkillInvocation['intent']
}

export function resolveDirectDocumentAssistantInvocation(input: {
  messages: AgentChatContextMessage[]
  contextSnapshots?: AgentChatContextSnapshot[] | null
  triggerUserMessageId: string | null | undefined
  skillContext?: AgentRuntimeSkillContext | null
}): DirectDocumentAssistantInvocation | null {
  if (!input.triggerUserMessageId) {
    return null
  }

  const triggerMessage = input.messages.find(message =>
    message.id === input.triggerUserMessageId && message.role === 'user',
  )
  const skillInvocation = triggerMessage?.skillInvocation

  if (skillInvocation?.skillKey !== AGENT_DOCUMENT_ASSISTANT_SKILL_KEY) {
    return null
  }

  if (!isDocumentAssistantAvailable(input.skillContext)) {
    return null
  }

  const contextSnapshot = resolveDocumentSelectionContextSnapshot(input.contextSnapshots, skillInvocation.intent)

  return {
    contextSnapshotIds: [contextSnapshot.id],
    skillKey: skillInvocation.skillKey,
    intent: skillInvocation.intent,
  }
}

function isDocumentAssistantAvailable(skillContext: AgentRuntimeSkillContext | null | undefined): boolean {
  return Boolean(skillContext?.availableSkills.some(skill => skill.key === AGENT_DOCUMENT_ASSISTANT_SKILL_KEY))
}

function resolveDocumentSelectionContextSnapshot(
  contextSnapshots: AgentChatContextSnapshot[] | null | undefined,
  intent: AgentDocumentAssistantSkillInvocation['intent'],
) {
  const snapshots = (contextSnapshots ?? []).filter(snapshot =>
    snapshot.type === 'document'
    && snapshot.scope.kind === 'selection'
    && snapshot.content.trim().length > 0
    && (
      intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR
      || !isCollapsedDocumentSelectionSnapshot(snapshot)
    ))

  if (snapshots.length !== 1) {
    throw new Error(snapshots.length === 0
      ? '文档助手缺少文档选区上下文'
      : '文档助手只能使用一个文档选区上下文')
  }

  return snapshots[0]!
}

function isCollapsedDocumentSelectionSnapshot(snapshot: AgentChatContextSnapshot) {
  return snapshot.scope.kind === 'selection'
    && snapshot.scope.from.blockId === snapshot.scope.to.blockId
    && snapshot.scope.from.offset === snapshot.scope.to.offset
}
