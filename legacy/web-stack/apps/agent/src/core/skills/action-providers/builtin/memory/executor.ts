import type {
  AgentMemoryLane,
  AgentMemoryOperationMode,
  AgentMemoryOperationProposal,
  AgentMemoryScope,
  AgentMemorySensitivity,
  ChatMemoryOperationProjection,
} from '@haohaoxue/lexora-contracts'
import type { ToolCall } from '@langchain/core/messages'
import type { AgentMemoryApiClient } from '../../../../../clients/memory'
import type { AgentGraphContext } from '../../../../state'
import {
  AGENT_MEMORY_OPERATION_ACTION,
  AGENT_MEMORY_TOOL,
  AgentMemoryOperationProposalSchema,
} from '@haohaoxue/lexora-contracts'
import { ToolMessage } from '@langchain/core/messages'
import {
  MemoryAskUserSchema,
  MemoryForgetSchema,
  MemoryIgnoreSchema,
  MemoryUpdateSchema,
  MemoryWriteBaseSchema,
} from './schemas'

export async function executeMemoryToolCalls(input: {
  memoryApi: AgentMemoryApiClient
  context: AgentGraphContext
  sessionId: string
  toolCalls: ToolCall[]
}): Promise<{
  toolMessages: ToolMessage[]
  operations: ChatMemoryOperationProjection[]
}> {
  const operations: ChatMemoryOperationProjection[] = []
  const toolMessages: ToolMessage[] = []
  const proposalEntries: Array<{
    toolCall: ToolCall
    proposal: AgentMemoryOperationProposal
  }> = []

  for (const toolCall of input.toolCalls) {
    let proposal: AgentMemoryOperationProposal | null
    try {
      proposal = toMemoryOperationProposal(toolCall)
    }
    catch (error) {
      toolMessages.push(createToolMessage(toolCall, {
        status: 'failed',
        reason: formatMemoryToolError(error),
      }, 'error'))
      continue
    }

    if (!proposal) {
      toolMessages.push(createToolMessage(toolCall, {
        status: 'ignored',
        reason: 'Unsupported memory tool call.',
      }, 'error'))
      continue
    }

    proposalEntries.push({ toolCall, proposal })
  }

  if (proposalEntries.length === 0) {
    return { toolMessages, operations }
  }

  const context = input.context
  if (!context.actorUserId || !context.generationId || !context.triggerUserMessageId) {
    for (const { toolCall } of proposalEntries) {
      toolMessages.push(createToolMessage(toolCall, {
        status: 'failed',
        reason: 'Missing memory execution context.',
      }, 'error'))
    }
    return { toolMessages, operations }
  }

  try {
    const response = await input.memoryApi.executeOperationProposals({
      actorUserId: context.actorUserId,
      sessionId: input.sessionId,
      messageId: context.triggerUserMessageId,
      generationId: context.generationId,
      agentProfileId: context.agentProfileId ?? null,
      memoryWritingPolicy: context.agentProfileConfig?.memoryPolicy.writing,
      operations: proposalEntries.map(entry => entry.proposal),
    })

    operations.push(...response.operations)
    for (const [index, { toolCall }] of proposalEntries.entries()) {
      const operation = response.operations[index]
      toolMessages.push(createToolMessage(toolCall, {
        status: 'ok',
        operations: operation
          ? [{
              action: operation.action,
              status: operation.status,
              title: operation.title,
              detail: operation.detail,
              reason: operation.reason,
            }]
          : [],
      }))
    }
  }
  catch (error) {
    for (const { toolCall } of proposalEntries) {
      toolMessages.push(createToolMessage(toolCall, {
        status: 'failed',
        reason: formatMemoryToolError(error),
      }, 'error'))
    }
  }

  return { toolMessages, operations }
}

function toMemoryOperationProposal(toolCall: ToolCall): AgentMemoryOperationProposal | null {
  switch (toolCall.name) {
    case AGENT_MEMORY_TOOL.REMEMBER:
      return createWriteProposal(toolCall.args, AGENT_MEMORY_OPERATION_ACTION.CREATE)
    case AGENT_MEMORY_TOOL.UPDATE:
      return createUpdateProposal(toolCall.args)
    case AGENT_MEMORY_TOOL.FORGET:
      return createForgetProposal(toolCall.args)
    case AGENT_MEMORY_TOOL.IGNORE:
      return createIgnoreProposal(toolCall.args)
    case AGENT_MEMORY_TOOL.ASK_USER:
      return createAskUserProposal(toolCall.args)
    default:
      return null
  }
}

function createWriteProposal(input: unknown, action: 'create' | 'update'): AgentMemoryOperationProposal {
  const value = MemoryWriteBaseSchema.parse(input)
  return parseProposal({
    action,
    mode: value.mode,
    scope: value.scope,
    lane: value.lane,
    slotKey: value.slotKey,
    slotValue: value.slotValue,
    content: value.content,
    summary: value.summary,
    query: null,
    relatedMemoryIds: value.relatedMemoryIds,
    confidence: value.confidence,
    sensitivity: value.sensitivity,
    reason: value.reason,
  })
}

function createUpdateProposal(input: unknown): AgentMemoryOperationProposal {
  const value = MemoryUpdateSchema.parse(input)
  return parseProposal({
    action: AGENT_MEMORY_OPERATION_ACTION.UPDATE,
    mode: value.mode,
    scope: value.scope,
    lane: value.lane,
    slotKey: value.slotKey,
    slotValue: value.slotValue,
    content: value.content,
    summary: value.summary,
    query: null,
    relatedMemoryIds: value.relatedMemoryIds,
    confidence: value.confidence,
    sensitivity: value.sensitivity,
    reason: value.reason,
  })
}

function createForgetProposal(input: unknown): AgentMemoryOperationProposal {
  const value = MemoryForgetSchema.parse(input)
  return parseProposal({
    action: AGENT_MEMORY_OPERATION_ACTION.FORGET,
    mode: value.mode,
    scope: value.scope,
    lane: value.lane,
    slotKey: null,
    slotValue: null,
    content: null,
    summary: null,
    query: value.query,
    relatedMemoryIds: value.relatedMemoryIds,
    confidence: value.confidence,
    sensitivity: value.sensitivity,
    reason: value.reason,
  })
}

function createIgnoreProposal(input: unknown): AgentMemoryOperationProposal {
  const value = MemoryIgnoreSchema.parse(input)
  return parseProposal({
    action: AGENT_MEMORY_OPERATION_ACTION.IGNORE,
    mode: value.mode,
    scope: value.scope,
    lane: value.lane,
    slotKey: null,
    slotValue: null,
    content: null,
    summary: null,
    query: value.query,
    relatedMemoryIds: [],
    confidence: value.confidence,
    sensitivity: value.sensitivity,
    reason: value.reason,
  })
}

function createAskUserProposal(input: unknown): AgentMemoryOperationProposal {
  const value = MemoryAskUserSchema.parse(input)
  return parseProposal({
    action: AGENT_MEMORY_OPERATION_ACTION.ASK_USER,
    mode: value.mode,
    scope: value.scope,
    lane: value.lane,
    slotKey: null,
    slotValue: null,
    content: null,
    summary: null,
    query: value.query,
    relatedMemoryIds: [],
    confidence: value.confidence,
    sensitivity: value.sensitivity,
    reason: value.reason,
  })
}

function parseProposal(input: {
  action: AgentMemoryOperationProposal['action']
  mode: AgentMemoryOperationMode
  scope: AgentMemoryScope
  lane: AgentMemoryLane
  slotKey: string | null
  slotValue: string | null
  content: string | null
  summary: string | null
  query: string | null
  relatedMemoryIds: string[]
  confidence: number
  sensitivity: AgentMemorySensitivity
  reason: string | null
}): AgentMemoryOperationProposal {
  return AgentMemoryOperationProposalSchema.parse(input)
}

function createToolMessage(
  toolCall: ToolCall,
  content: unknown,
  status: 'success' | 'error' = 'success',
): ToolMessage {
  return new ToolMessage({
    tool_call_id: toolCall.id ?? `${toolCall.name}:missing-id`,
    status,
    content: JSON.stringify(content),
  })
}

function formatMemoryToolError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Memory tool execution failed.'
}
