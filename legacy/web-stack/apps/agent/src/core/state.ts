import type {
  AgentChatContextMessage,
  AgentChatContextSnapshot,
  AgentChatInputAttachment,
  AgentContextPolicy,
  AgentMemoryRetrievalSnapshot,
  AgentProfileConfig,
  AgentRuntimeHints,
  AgentRuntimeModelTarget,
  AgentRuntimeSkillContext,
  AgentRuntimeSkillCredentials,
  ChatGenerationUsageSnapshot,
  ChatMemoryOperationProjection,
  ResolvedLanguagePreference,
} from '@haohaoxue/lexora-contracts'
import type { AgentChatModelOptions } from '../integrations/model-providers/chat-model'
import type { AgentModelStreamPart } from '../integrations/model-providers/stream-text'
import type { AgentContextBudget, AgentModelLimits } from './context/budget'
import type { AgentHistoryDigest } from './context/history-compaction'
import type { DirectDocumentAssistantInvocation } from './skills/direct-invocations/document-assistant'
import type { DirectTranslatorInvocation } from './skills/direct-invocations/translator'
import { Annotation } from '@langchain/langgraph'

export const AgentGraphState = Annotation.Root({
  sessionId: Annotation<string>(),
  sessionHistoryVersion: Annotation<number>(),
  activePathKey: Annotation<string>(),
  activePathTailMessageId: Annotation<string>(),
  olderMessagesExcerpt: Annotation<string>(),
  historyDigest: Annotation<AgentHistoryDigest | null>(),
  memoryRetrieval: Annotation<AgentMemoryRetrievalSnapshot | null>(),
  messages: Annotation<AgentChatContextMessage[], AgentChatContextMessage[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  contextBudget: Annotation<AgentContextBudget | null>(),
  usageSnapshot: Annotation<ChatGenerationUsageSnapshot | null>(),
  responseText: Annotation<string>(),
  memoryOperations: Annotation<ChatMemoryOperationProjection[], ChatMemoryOperationProjection[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
})

export interface AgentGraphContext {
  generationId?: string | null
  actorUserId?: string | null
  agentProfileId?: string | null
  modelTarget?: AgentRuntimeModelTarget | null
  modelOptions?: AgentChatModelOptions | null
  modelLimits?: AgentModelLimits | null
  agentProfileConfig?: AgentProfileConfig | null
  skillContext?: AgentRuntimeSkillContext | null
  skillCredentials?: AgentRuntimeSkillCredentials | null
  disabledSkillKeys?: string[]
  runtimeHints?: AgentRuntimeHints | null
  contextPolicy?: AgentContextPolicy | null
  contextBudget?: AgentContextBudget | null
  defaultResponseLanguage?: ResolvedLanguagePreference | null
  memoryIgnoredForRun?: boolean
  directDocumentAssistantInvocation?: DirectDocumentAssistantInvocation | null
  directTranslatorInvocation?: DirectTranslatorInvocation | null
  triggerUserMessageId?: string | null
  contextSnapshots?: AgentChatContextSnapshot[] | null
  inputAttachments?: AgentChatInputAttachment[] | null
  onStreamPart?: (part: AgentModelStreamPart) => Promise<void> | void
  onRuntimeWarning?: (warning: AgentRuntimeWarning) => Promise<void> | void
}

export interface AgentRuntimeWarning {
  code: string
  message: string
  details?: Record<string, unknown>
}
