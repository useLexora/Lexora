import type { ChatMemoryOperationProjection } from '@haohaoxue/lexora-contracts'
import type { ToolMessage } from '@langchain/core/messages'
import type { AgentMemoryApiClient } from '../../clients/memory'
import type { AgentSkillApiClient } from '../../clients/skills'
import type { AgentModelStreamPart } from '../../integrations/model-providers/stream-text'
import type { WebSearchClient } from '../../integrations/web-search'
import type { RuntimeSkillActionProvider } from '../skills/action-providers'
import type { LoadedAgentSkill } from '../skills/activation'
import type { AgentGraphContext } from '../state'
import type { AgentToolProtocol } from './protocol'
import type { RuntimeSkillActionMetadata } from './registry'
import type { BaseToolCall } from './utils'
import {
  AGENT_LOCATION_TOOL_VALUES,
  AGENT_TIME_TOOL_VALUES,
  AGENT_WEB_SEARCH_TOOL_VALUES,
  GetCurrentLocationToolResponseSchema,
  GetCurrentTimeToolResponseSchema,
} from '@haohaoxue/lexora-contracts/agent'
import { isGraphInterrupt } from '@langchain/langgraph'
import { executeRuntimeToolCalls } from './dispatch'
import {
  formatToolExecutionError,
  getToolCallId,
  stringifyToolPayload,
} from './utils'

export type ToolProtocolUnavailableReason = Extract<AgentToolProtocol, { kind: 'none' }>['reason']

export interface RuntimeToolExecutionResult {
  toolMessages: ToolMessage[]
  operations: ChatMemoryOperationProjection[]
  loadedSkills: LoadedAgentSkill[]
}

export async function emitToolProtocolUnavailableWarning(input: {
  context: AgentGraphContext | undefined
  reason: ToolProtocolUnavailableReason
  visibleToolCount: number
}): Promise<void> {
  if (input.reason === 'no-visible-tools') {
    return
  }

  await input.context?.onRuntimeWarning?.({
    code: 'agent_tool_protocol_unavailable',
    message: 'Runtime tools are visible but disabled because no safe model tool protocol is available.',
    details: {
      reason: input.reason,
      visibleToolCount: input.visibleToolCount,
      providerId: input.context?.modelTarget?.providerId,
      adapterKey: input.context?.modelTarget?.adapterKey,
      modelId: input.context?.modelTarget?.modelId,
      capabilities: input.context?.modelTarget?.capabilities ?? [],
    },
  })
}

export async function executeRuntimeToolCallsWithEvents(input: {
  memoryApi?: AgentMemoryApiClient
  skillApi?: AgentSkillApiClient
  webSearch?: WebSearchClient
  skillActionProviders?: readonly RuntimeSkillActionProvider[]
  context: AgentGraphContext | undefined
  sessionId: string
  toolCalls: BaseToolCall[]
  loadedSkills: LoadedAgentSkill[]
}): Promise<RuntimeToolExecutionResult> {
  const startedAtByToolCallId = new Map<string, number>()
  const actionMetadataByToolCallId = new Map<string, RuntimeSkillActionMetadata>()

  try {
    const result = await executeRuntimeToolCalls({
      memoryApi: input.memoryApi,
      webSearch: input.webSearch,
      skillApi: input.skillApi,
      skillActionProviders: input.skillActionProviders,
      context: input.context ?? {},
      sessionId: input.sessionId,
      toolCalls: input.toolCalls,
      loadedSkills: input.loadedSkills,
      observer: {
        async onToolCallsStarted(toolCalls, metadataByActionName) {
          const groupStartedAtByToolCallId = await emitToolExecutionStarts({
            context: input.context,
            toolCalls,
            skillActionMetadataByActionName: metadataByActionName,
          })

          for (const [toolCallId, startedAt] of groupStartedAtByToolCallId) {
            startedAtByToolCallId.set(toolCallId, startedAt)
          }

          for (const toolCall of toolCalls) {
            const toolCallId = getToolCallId(toolCall)
            actionMetadataByToolCallId.set(
              toolCallId,
              getSkillActionMetadata(toolCall.name, metadataByActionName),
            )
          }
        },
        async onToolCallsCompleted(toolCalls, toolMessages) {
          await emitToolExecutionResults({
            context: input.context,
            toolCalls,
            toolMessages,
            startedAtByToolCallId,
            actionMetadataByToolCallId,
          })
        },
        async onToolCallsFailed(toolCalls, error) {
          await emitToolExecutionFailures({
            context: input.context,
            toolCalls,
            startedAtByToolCallId,
            actionMetadataByToolCallId,
            error,
          })
        },
      },
    })

    return result
  }
  catch (error) {
    if (isGraphInterrupt(error)) {
      throw error
    }

    throw error
  }
}

export function shouldContinueWithFinalResponse(input: {
  toolCalls: BaseToolCall[]
  toolMessages: Array<{
    tool_call_id?: string
    content?: unknown
    status?: 'success' | 'error'
  }>
}): boolean {
  return input.toolMessages.some(message => message.status === 'error')
    || hasUserInputRequiredToolResult(input)
    || input.toolCalls.some(toolCall => (AGENT_WEB_SEARCH_TOOL_VALUES as readonly string[]).includes(toolCall.name))
}

function hasUserInputRequiredToolResult(input: {
  toolCalls: BaseToolCall[]
  toolMessages: Array<{
    tool_call_id?: string
    content?: unknown
  }>
}): boolean {
  const toolMessageByCallId = new Map(input.toolMessages.map(message => [message.tool_call_id, message]))

  return input.toolCalls.some((toolCall) => {
    const toolMessage = toolMessageByCallId.get(getToolCallId(toolCall))
    if (!toolMessage) {
      return false
    }

    return isUserInputRequiredActionResult(toolCall.name, toolMessage.content)
  })
}

function isUserInputRequiredActionResult(actionName: string, content: unknown): boolean {
  const payload = parseToolJsonPayload(content)
  if (!payload) {
    return false
  }

  if ((AGENT_LOCATION_TOOL_VALUES as readonly string[]).includes(actionName)) {
    const parsed = GetCurrentLocationToolResponseSchema.safeParse(payload)
    return parsed.success && parsed.data.status === 'needs_location'
  }

  if ((AGENT_TIME_TOOL_VALUES as readonly string[]).includes(actionName)) {
    const parsed = GetCurrentTimeToolResponseSchema.safeParse(payload)
    return parsed.success && parsed.data.status === 'needs_timezone'
  }

  return false
}

function parseToolJsonPayload(content: unknown): unknown | null {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content)
    }
    catch {
      return null
    }
  }

  return isRecord(content) ? content : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function emitToolExecutionStarts(input: {
  context: AgentGraphContext | undefined
  toolCalls: BaseToolCall[]
  skillActionMetadataByActionName: ReadonlyMap<string, RuntimeSkillActionMetadata>
}): Promise<Map<string, number>> {
  const toolExecutionStartedAt = new Map<string, number>()
  for (const toolCall of input.toolCalls) {
    const toolCallId = getToolCallId(toolCall)
    const actionMetadata = getSkillActionMetadata(toolCall.name, input.skillActionMetadataByActionName)
    toolExecutionStartedAt.set(toolCallId, Date.now())
    await input.context?.onStreamPart?.({
      type: 'tool.execution.started',
      toolCallId,
      skillKey: actionMetadata.skillKey,
      actionName: toolCall.name,
      connectorType: actionMetadata.connectorType,
      args: toolCall.args,
      argsText: stringifyToolPayload(toolCall.args),
      raw: toolCall,
    })
  }

  return toolExecutionStartedAt
}

async function emitToolExecutionResults(input: {
  context: AgentGraphContext | undefined
  toolCalls: BaseToolCall[]
  toolMessages: Array<{
    tool_call_id: string
    content: unknown
    status?: 'success' | 'error'
  }>
  startedAtByToolCallId: Map<string, number>
  actionMetadataByToolCallId: ReadonlyMap<string, RuntimeSkillActionMetadata>
}): Promise<void> {
  const messagesByToolCallId = new Map(input.toolMessages.map(message => [message.tool_call_id, message]))

  for (const toolCall of input.toolCalls) {
    const toolCallId = getToolCallId(toolCall)
    const startedAt = input.startedAtByToolCallId.get(toolCallId) ?? Date.now()
    const durationMs = Math.max(0, Math.trunc(Date.now() - startedAt))
    const actionMetadata = getSkillActionMetadataByToolCallId(
      toolCallId,
      input.actionMetadataByToolCallId,
    )
    const toolMessage = messagesByToolCallId.get(toolCallId)
    const outputText = toolMessage ? stringifyToolPayload(toolMessage.content) : undefined
    const status = toolMessage?.status === 'error' ? 'error' : 'success'

    await input.context?.onStreamPart?.({
      type: 'tool.execution.completed',
      toolCallId,
      skillKey: actionMetadata.skillKey,
      actionName: toolCall.name,
      connectorType: actionMetadata.connectorType,
      status,
      output: toolMessage?.content,
      outputText,
      durationMs,
      raw: toolMessage,
    } satisfies AgentModelStreamPart)
  }
}

async function emitToolExecutionFailures(input: {
  context: AgentGraphContext | undefined
  toolCalls: BaseToolCall[]
  startedAtByToolCallId: Map<string, number>
  actionMetadataByToolCallId: ReadonlyMap<string, RuntimeSkillActionMetadata>
  error: unknown
}): Promise<void> {
  for (const toolCall of input.toolCalls) {
    const toolCallId = getToolCallId(toolCall)
    const startedAt = input.startedAtByToolCallId.get(toolCallId) ?? Date.now()
    const actionMetadata = getSkillActionMetadataByToolCallId(
      toolCallId,
      input.actionMetadataByToolCallId,
    )
    await input.context?.onStreamPart?.({
      type: 'tool.execution.failed',
      toolCallId,
      skillKey: actionMetadata.skillKey,
      actionName: toolCall.name,
      connectorType: actionMetadata.connectorType,
      message: formatToolExecutionError(input.error),
      durationMs: Math.max(0, Math.trunc(Date.now() - startedAt)),
      raw: input.error,
    } satisfies AgentModelStreamPart)
  }
}

function getSkillActionMetadata(
  actionName: string,
  metadataByActionName: ReadonlyMap<string, RuntimeSkillActionMetadata>,
): RuntimeSkillActionMetadata {
  return metadataByActionName.get(actionName) ?? {}
}

function getSkillActionMetadataByToolCallId(
  toolCallId: string,
  metadataByToolCallId: ReadonlyMap<string, RuntimeSkillActionMetadata>,
): RuntimeSkillActionMetadata {
  return metadataByToolCallId.get(toolCallId) ?? {}
}
