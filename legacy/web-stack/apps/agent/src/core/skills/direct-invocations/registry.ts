import type {
  AgentChatContextMessage,
  AgentChatContextSnapshot,
  AgentProfileConfig,
  AgentRuntimeSkillContext,
} from '@haohaoxue/lexora-contracts'
import type { DirectDocumentAssistantInvocation } from './document-assistant'
import type { DirectTranslatorInvocation } from './translator'
import {
  AGENT_DOCUMENT_ASSISTANT_SKILL_KEY,
  AGENT_TRANSLATOR_SKILL_KEY,
} from '@haohaoxue/lexora-contracts'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { applyAgentContextSnapshotsToMessages } from '../../context/snapshots'
import {
  createDirectDocumentAssistantHumanContent,
  createDirectDocumentAssistantSystemPrompt,
  createDirectDocumentAssistantThreadId,
  resolveDirectDocumentAssistantInvocation,
} from './document-assistant'
import {
  createDirectTranslatorHumanContent,
  createDirectTranslatorSystemPrompt,
  createDirectTranslatorThreadId,
  resolveDirectTranslatorInvocation,
} from './translator'

export type DirectInvocationRuntime
  = | {
    kind: typeof AGENT_TRANSLATOR_SKILL_KEY
    invocation: DirectTranslatorInvocation
  }
  | {
    kind: typeof AGENT_DOCUMENT_ASSISTANT_SKILL_KEY
    invocation: DirectDocumentAssistantInvocation
  }

export type DirectInvocationRun = DirectInvocationRuntime & {
  graphThreadId: string
  stateContext: {
    directDocumentAssistantInvocation?: DirectDocumentAssistantInvocation | null
    directTranslatorInvocation?: DirectTranslatorInvocation | null
  }
}

interface ResolveDirectInvocationInput {
  messages: AgentChatContextMessage[]
  contextSnapshots?: AgentChatContextSnapshot[] | null
  triggerUserMessageId: string | null | undefined
  threadId: string
  generationId: string
  agentProfileConfig?: AgentProfileConfig | null
  skillContext?: AgentRuntimeSkillContext | null
}

type DirectInvocationResolver = (input: ResolveDirectInvocationInput) => DirectInvocationRun | null

const DIRECT_INVOCATION_RESOLVERS: readonly DirectInvocationResolver[] = [
  resolveTranslatorRun,
  resolveDocumentAssistantRun,
]

export function resolveDirectInvocationRun(input: ResolveDirectInvocationInput): DirectInvocationRun | null {
  for (const resolver of DIRECT_INVOCATION_RESOLVERS) {
    const run = resolver(input)
    if (run) {
      return run
    }
  }

  return null
}

export function resolveDirectInvocationRuntime(context: {
  directDocumentAssistantInvocation?: DirectDocumentAssistantInvocation | null
  directTranslatorInvocation?: DirectTranslatorInvocation | null
} | null | undefined): DirectInvocationRuntime | null {
  if (context?.directTranslatorInvocation) {
    return {
      kind: AGENT_TRANSLATOR_SKILL_KEY,
      invocation: context.directTranslatorInvocation,
    }
  }

  if (context?.directDocumentAssistantInvocation) {
    return {
      kind: AGENT_DOCUMENT_ASSISTANT_SKILL_KEY,
      invocation: context.directDocumentAssistantInvocation,
    }
  }

  return null
}

export function createDirectInvocationSystemPrompt(runtime: DirectInvocationRuntime): string {
  switch (runtime.kind) {
    case AGENT_TRANSLATOR_SKILL_KEY:
      return createDirectTranslatorSystemPrompt(runtime.invocation)
    case AGENT_DOCUMENT_ASSISTANT_SKILL_KEY:
      return createDirectDocumentAssistantSystemPrompt(runtime.invocation)
  }
}

export function createDirectInvocationMessages(input: {
  messages: AgentChatContextMessage[]
  runtime: DirectInvocationRuntime
  triggerUserMessageId: string | null | undefined
  contextSnapshots?: AgentChatContextSnapshot[] | null
}) {
  switch (input.runtime.kind) {
    case AGENT_TRANSLATOR_SKILL_KEY:
      return toDirectTranslatorMessages(
        input.messages,
        input.runtime.invocation,
        input.triggerUserMessageId,
      )
    case AGENT_DOCUMENT_ASSISTANT_SKILL_KEY:
      return toDirectDocumentAssistantMessages(
        input.messages,
        input.runtime.invocation,
        input.triggerUserMessageId,
        input.contextSnapshots,
      )
  }
}

export function resolveContextSnapshotsForDirectInvocation(
  runtime: DirectInvocationRuntime,
  contextSnapshots: AgentChatContextSnapshot[] | null | undefined,
): AgentChatContextSnapshot[] {
  if (!shouldPassContextSnapshotsToDirectInvocation(runtime)) {
    return []
  }

  const ids = new Set(runtime.invocation.contextSnapshotIds)
  return (contextSnapshots ?? []).filter(snapshot => ids.has(snapshot.id))
}

export function shouldPassContextSnapshotsToDirectInvocation(
  runtime: DirectInvocationRuntime,
): runtime is Extract<DirectInvocationRuntime, { kind: typeof AGENT_DOCUMENT_ASSISTANT_SKILL_KEY }> {
  return runtime.kind === AGENT_DOCUMENT_ASSISTANT_SKILL_KEY
}

function resolveTranslatorRun(input: ResolveDirectInvocationInput): DirectInvocationRun | null {
  const invocation = resolveDirectTranslatorInvocation({
    messages: input.messages,
    triggerUserMessageId: input.triggerUserMessageId,
    agentProfileConfig: input.agentProfileConfig,
    skillContext: input.skillContext,
  })

  if (!invocation) {
    return null
  }

  return {
    kind: AGENT_TRANSLATOR_SKILL_KEY,
    invocation,
    graphThreadId: createDirectTranslatorThreadId(input.threadId, input.generationId),
    stateContext: {
      directTranslatorInvocation: invocation,
      directDocumentAssistantInvocation: null,
    },
  }
}

function resolveDocumentAssistantRun(input: ResolveDirectInvocationInput): DirectInvocationRun | null {
  const invocation = resolveDirectDocumentAssistantInvocation({
    messages: input.messages,
    contextSnapshots: input.contextSnapshots,
    triggerUserMessageId: input.triggerUserMessageId,
    skillContext: input.skillContext,
  })

  if (!invocation) {
    return null
  }

  return {
    kind: AGENT_DOCUMENT_ASSISTANT_SKILL_KEY,
    invocation,
    graphThreadId: createDirectDocumentAssistantThreadId(input.threadId, input.generationId),
    stateContext: {
      directDocumentAssistantInvocation: invocation,
      directTranslatorInvocation: null,
    },
  }
}

function toDirectDocumentAssistantMessages(
  messages: AgentChatContextMessage[],
  invocation: DirectDocumentAssistantInvocation,
  triggerUserMessageId: string | null | undefined,
  contextSnapshots: AgentChatContextSnapshot[] | null | undefined,
) {
  const contextualMessages = applyAgentContextSnapshotsToMessages(messages, {
    triggerUserMessageId,
    contextSnapshots,
  })
  const sourceMessage = findDirectInvocationSourceMessage(contextualMessages, triggerUserMessageId)

  if (!sourceMessage) {
    throw new Error('文档助手缺少用户正文')
  }

  return [
    new SystemMessage(createDirectDocumentAssistantSystemPrompt(invocation)),
    new HumanMessage({
      id: sourceMessage.id,
      content: createDirectDocumentAssistantHumanContent(sourceMessage),
    }),
  ]
}

function toDirectTranslatorMessages(
  messages: AgentChatContextMessage[],
  invocation: DirectTranslatorInvocation,
  triggerUserMessageId: string | null | undefined,
) {
  const sourceMessage = findDirectInvocationSourceMessage(messages, triggerUserMessageId)

  if (!sourceMessage) {
    throw new Error('翻译技能缺少用户正文')
  }

  return [
    new SystemMessage(createDirectTranslatorSystemPrompt(invocation)),
    new HumanMessage({
      id: sourceMessage.id,
      content: createDirectTranslatorHumanContent(sourceMessage),
    }),
  ]
}

function findDirectInvocationSourceMessage(
  messages: AgentChatContextMessage[],
  triggerUserMessageId: string | null | undefined,
) {
  const triggerMessage = triggerUserMessageId
    ? messages.find(message => message.id === triggerUserMessageId && message.role === 'user')
    : null
  return triggerMessage ?? messages.findLast(message => message.role === 'user') ?? messages.at(-1)
}
