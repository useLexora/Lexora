import type {
  AgentChatContextMessage,
  AgentMemoryPolicy,
  AgentMemoryRetrievalSnapshot,
} from '@haohaoxue/lexora-contracts'
import type { GraphNode } from '@langchain/langgraph'
import type { AgentMemoryApiClient } from '../../clients/memory'
import type { AgentGraphContext, AgentGraphState } from '../state'
import {
  AgentMemoryRetrievalSnapshotSchema,
} from '@haohaoxue/lexora-contracts'
import { resolveDirectInvocationRuntime } from '../skills/direct-invocations'

export interface CreateRetrieveMemoryNodeOptions {
  memoryApi?: AgentMemoryApiClient
}

export function createRetrieveMemoryNode(options: CreateRetrieveMemoryNodeOptions): GraphNode<typeof AgentGraphState, AgentGraphContext> {
  return async (state, config) => {
    const memoryApi = options.memoryApi
    const profileConfig = config.context?.agentProfileConfig
    const generationId = config.context?.generationId
    const actorUserId = config.context?.actorUserId

    if (resolveDirectInvocationRuntime(config.context)) {
      return {
        memoryRetrieval: null,
      }
    }

    if (!memoryApi || !profileConfig || !generationId || !actorUserId) {
      return {}
    }

    const policy = {
      ...profileConfig.memoryPolicy,
      ignoredForRun: profileConfig.memoryPolicy.ignoredForRun || Boolean(config.context?.memoryIgnoredForRun),
    }
    const query = resolveMemoryQuery(state, config.context?.triggerUserMessageId)

    try {
      const response = await memoryApi.retrieveMemories({
        actorUserId,
        agentProfileId: config.context?.agentProfileId ?? null,
        generationId,
        sessionId: state.sessionId,
        query,
        policy,
      })

      return {
        memoryRetrieval: response.snapshot,
      }
    }
    catch {
      return {
        memoryRetrieval: createRuntimeMemoryFallbackSnapshot(policy, query),
      }
    }
  }
}

function resolveMemoryQuery(
  state: { messages: AgentChatContextMessage[] },
  triggerUserMessageId: string | null | undefined,
): string {
  const triggerMessage = triggerUserMessageId
    ? state.messages.find(message => message.id === triggerUserMessageId)
    : null

  return (triggerMessage ?? state.messages.at(-1))?.content ?? ''
}

function createRuntimeMemoryFallbackSnapshot(policy: AgentMemoryPolicy, query: string): AgentMemoryRetrievalSnapshot {
  return AgentMemoryRetrievalSnapshotSchema.parse({
    enabled: policy.enabled,
    ignoredForRun: policy.ignoredForRun,
    query,
    scopes: policy.scopes,
    lanes: policy.lanes,
    selectedMemoryIds: [],
    omittedMemoryIds: [],
    injectedCount: 0,
    estimatedTokens: 0,
    budgetTokens: policy.maxInjectedTokens,
    retriever: 'disabled',
    renderedSections: [],
    createdAt: new Date().toISOString(),
  })
}
