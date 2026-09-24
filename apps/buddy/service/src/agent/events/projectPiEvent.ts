import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ToolResultMessage,
} from '@earendil-works/pi-ai'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { BuddyAssistantTextPhase } from '../../../../shared/runs/assistantTextPhase'
import type { BuddyToolPresentation } from '../../../../shared/runs/runEventPresentation'
import type { BuddyRunProgress } from '../../../../shared/runs/runProgress'
import { randomUUID } from 'node:crypto'

import { MAX_BUDDY_MESSAGE_TEXT_LENGTH } from '../../../../shared/conversation/buddyMessageContent'
import { redactSensitiveText } from '../../../../shared/permissions/approvalReviewPayload'
import { buddyAssistantTextPhaseSchema } from '../../../../shared/runs/assistantTextPhase'
import { isToolFailureCode } from '../../../../shared/runs/toolFailure'
import {
  createBuddyRunOutputs,
  createBuddyToolPresentation,
} from './toolPresentation'

export type BuddyProjectedEventType
  = 'context.compaction.cancelled'
    | 'context.compaction.completed'
    | 'context.compaction.failed'
    | 'context.compaction.started'
    | 'message.completed'
    | 'message.block.completed'
    | 'message.block.delta'
    | 'message.block.started'
    | 'message.delta'
    | 'message.started'
    | 'message.tool_result'
    | 'output.produced'
    | 'run.progress'
    | 'tool.completed'
    | 'tool.denied'
    | 'tool.failed'
    | 'tool.preparing'
    | 'tool.started'
    | 'tool.updated'

export interface BuddyProjectedEvent {
  payload: unknown
  type: BuddyProjectedEventType
}

export interface PiEventProjection {
  events: BuddyProjectedEvent[]
  failureCode?: ModelRequestFailureCode | 'MODEL_REQUEST_ABORTED'
  failureMessage?: string
  sourceMessageId?: string
}

type ModelRequestFailureCode
  = 'MODEL_NOT_SUPPORTED'
    | 'MODEL_INPUT_UNSUPPORTED'
    | 'MODEL_INPUT_TOO_LARGE'
    | 'RESOURCE_MATERIALIZATION_FAILED'
    | 'MODEL_REQUEST_FAILED'
    | 'MODEL_STREAM_INCOMPLETE'
    | 'MODEL_REQUEST_TIMED_OUT'
    | 'MODEL_SERVICE_UNAVAILABLE'
    | 'MODEL_SERVICE_UNREACHABLE'
    | 'PROVIDER_ACCESS_DENIED'
    | 'PROVIDER_AUTHENTICATION_FAILED'
    | 'PROVIDER_RATE_LIMITED'

interface ToolCallState {
  arguments: unknown
  presentation: BuddyToolPresentation
  toolName: string
}

export interface PiEventProjectionState {
  assistantMessageId: string | null
  canonicalRoot?: string
  completedCommentaryBlockIndexes: Set<number>
  progress: BuddyRunProgress | null
  toolCalls: Map<string, ToolCallState>
}

export interface AuthorizedToolExecution {
  arguments: unknown
  toolCallId: string
  toolName: string
}

export interface DeniedToolExecution {
  denialCode: string
  toolCallId: string
  toolName: string
}

type SessionMessage = Extract<AgentSessionEvent, { type: 'message_end' }>['message']

const MAX_DELTA_LENGTH = 64 * 1024
const MAX_FAILURE_MESSAGE_LENGTH = 4 * 1024
const TERMINAL_PRESENTATION_CHECKPOINT_INTERVAL = 16 * 1024
export function createPiEventProjectionState(
  options: { canonicalRoot?: string } = {},
): PiEventProjectionState {
  return {
    assistantMessageId: null,
    canonicalRoot: options.canonicalRoot,
    completedCommentaryBlockIndexes: new Set(),
    progress: null,
    toolCalls: new Map(),
  }
}

export function projectPiEvent(
  event: AgentSessionEvent,
  state: PiEventProjectionState,
): PiEventProjection {
  switch (event.type) {
    case 'agent_start':
      return progressProjection(state, 'preparing')
    case 'agent_settled':
      return progressProjection(state, 'idle')
    case 'turn_start':
    case 'auto_retry_start':
      return progressProjection(state, 'model_requesting')
    case 'compaction_start':
      return {
        events: [{
          payload: { reason: event.reason },
          type: 'context.compaction.started',
        }],
      }
    case 'compaction_end':
      return projectCompactionEnd(event)
    case 'message_start':
      return projectMessageStart(event.message, state)
    case 'message_update':
      return projectMessageUpdate(event.assistantMessageEvent, state)
    case 'message_end':
      return projectMessageEnd(event.message, state)
    case 'tool_execution_start': {
      const presentation = createBuddyToolPresentation({
        arguments: event.args,
        canonicalRoot: state.canonicalRoot,
        toolName: event.toolName,
      })
      state.toolCalls.set(event.toolCallId, {
        arguments: event.args,
        presentation,
        toolName: event.toolName,
      })
      return {
        events: [
          {
            payload: {
              presentation,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            },
            type: 'tool.preparing',
          },
          ...progressProjection(state, 'preparing', event.toolName).events,
        ],
      }
    }
    case 'tool_execution_update': {
      const previous = state.toolCalls.get(event.toolCallId)
      const presentation = createBuddyToolPresentation({
        arguments: event.args,
        canonicalRoot: state.canonicalRoot,
        result: event.partialResult,
        toolName: event.toolName,
      })
      state.toolCalls.set(event.toolCallId, {
        arguments: previous?.arguments ?? event.args,
        presentation,
        toolName: event.toolName,
      })
      const presentationUpdate = projectToolPresentationUpdate(
        previous?.presentation,
        presentation,
      )
      return {
        events: [
          ...(presentationUpdate
            ? [{
                payload: {
                  ...presentationUpdate,
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                },
                type: 'tool.updated' as const,
              }]
            : []),
          ...progressProjection(state, 'tool_executing', event.toolName).events,
        ],
      }
    }
    case 'tool_execution_end': {
      const tool = state.toolCalls.get(event.toolCallId)
      state.toolCalls.delete(event.toolCallId)
      const presentation = createBuddyToolPresentation({
        arguments: tool?.arguments,
        canonicalRoot: state.canonicalRoot,
        isError: event.isError,
        result: event.result,
        toolName: event.toolName,
      })
      const outputs = createBuddyRunOutputs({
        arguments: tool?.arguments,
        canonicalRoot: state.canonicalRoot,
        isError: event.isError,
        result: event.result,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      })
      return {
        events: [
          {
            payload: {
              isError: event.isError,
              presentation,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            },
            type: 'tool.completed',
          },
          ...outputs.map(payload => ({
            payload,
            type: 'output.produced' as const,
          })),
        ],
      }
    }
  }
  return { events: [] }
}

export function projectToolExecutionAuthorized(
  event: AuthorizedToolExecution,
  state: PiEventProjectionState,
): PiEventProjection {
  const tool = state.toolCalls.get(event.toolCallId) ?? createToolCallState(event, state)
  state.toolCalls.set(event.toolCallId, tool)
  return {
    events: [
      {
        payload: {
          presentation: tool.presentation,
          toolCallId: event.toolCallId,
          toolName: tool.toolName,
        },
        type: 'tool.started',
      },
      ...progressProjection(state, 'tool_executing', tool.toolName).events,
    ],
  }
}

export function projectToolExecutionDenied(
  event: DeniedToolExecution,
): PiEventProjection {
  const failed = isToolFailureCode(event.denialCode)
  return {
    events: [{
      payload: {
        ...(failed ? { errorCode: event.denialCode } : { denialCode: event.denialCode }),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      },
      type: failed ? 'tool.failed' : 'tool.denied',
    }],
  }
}

function createToolCallState(
  event: AuthorizedToolExecution,
  state: PiEventProjectionState,
): ToolCallState {
  return {
    arguments: event.arguments,
    presentation: createBuddyToolPresentation({
      arguments: event.arguments,
      canonicalRoot: state.canonicalRoot,
      toolName: event.toolName,
    }),
    toolName: event.toolName,
  }
}

function projectToolPresentationUpdate(
  previous: BuddyToolPresentation | undefined,
  current: BuddyToolPresentation,
): Record<string, unknown> | null {
  if (
    previous?.card !== 'terminal'
    || current.card !== 'terminal'
    || previous.output === null
    || current.output === null
    || previous.command !== current.command
    || previous.cwd !== current.cwd
    || previous.description !== current.description
    || previous.exitCode !== current.exitCode
    || previous.signal !== current.signal
    || !current.output.startsWith(previous.output)
    || crossesTerminalPresentationCheckpoint(previous.output.length, current.output.length)
  ) {
    return { presentation: current }
  }
  if (previous.output === current.output && previous.truncated === current.truncated)
    return null
  return {
    presentationDelta: {
      card: 'terminal',
      outputDelta: current.output.slice(previous.output.length),
      outputStart: previous.output.length,
      truncated: current.truncated,
    },
  }
}

function crossesTerminalPresentationCheckpoint(previousLength: number, currentLength: number): boolean {
  return Math.floor(previousLength / TERMINAL_PRESENTATION_CHECKPOINT_INTERVAL)
    < Math.floor(currentLength / TERMINAL_PRESENTATION_CHECKPOINT_INTERVAL)
}

function projectCompactionEnd(
  event: Extract<AgentSessionEvent, { type: 'compaction_end' }>,
): PiEventProjection {
  if (event.result) {
    return {
      events: [{
        payload: {
          estimatedTokensAfter: event.result.estimatedTokensAfter ?? null,
          reason: event.reason,
          tokensBefore: event.result.tokensBefore,
          willRetry: event.willRetry,
        },
        type: 'context.compaction.completed',
      }],
    }
  }
  if (event.aborted) {
    return {
      events: [{
        payload: { reason: event.reason, willRetry: event.willRetry },
        type: 'context.compaction.cancelled',
      }],
    }
  }
  return {
    events: [{
      payload: {
        errorCode: 'COMPACTION_FAILED',
        reason: event.reason,
        willRetry: event.willRetry,
      },
      type: 'context.compaction.failed',
    }],
  }
}

function projectMessageStart(
  message: { role: string },
  state: PiEventProjectionState,
): PiEventProjection {
  if (message.role !== 'assistant')
    return { events: [] }
  const messageId = randomUUID()
  state.assistantMessageId = messageId
  state.completedCommentaryBlockIndexes.clear()
  return {
    events: [
      {
        payload: { messageId, role: 'assistant' },
        type: 'message.started',
      },
      ...progressProjection(state, 'model_streaming').events,
    ],
  }
}

function progressProjection(
  state: PiEventProjectionState,
  phase: BuddyRunProgress['phase'],
  toolName: string | null = null,
): PiEventProjection {
  const progress: BuddyRunProgress = {
    phase,
    toolName: toolName?.slice(0, 256) || null,
  }
  if (
    state.progress?.phase === progress.phase
    && state.progress.toolName === progress.toolName
  ) {
    return { events: [] }
  }
  state.progress = progress
  return {
    events: [{ payload: progress, type: 'run.progress' }],
  }
}

function projectMessageUpdate(
  event: AssistantMessageEvent,
  state: PiEventProjectionState,
): PiEventProjection {
  const messageId = state.assistantMessageId ?? randomUUID()
  state.assistantMessageId = messageId
  if (event.type === 'thinking_start') {
    return {
      events: [{
        payload: {
          contentIndex: event.contentIndex,
          kind: 'reasoning',
          messageId,
        },
        type: 'message.block.started',
      }],
    }
  }
  if (event.type === 'thinking_delta' && event.delta) {
    return {
      events: [{
        payload: {
          contentIndex: event.contentIndex,
          delta: event.delta.slice(0, MAX_DELTA_LENGTH),
          kind: 'reasoning',
          messageId,
        },
        type: 'message.block.delta',
      }],
    }
  }
  if (event.type === 'thinking_end') {
    return {
      events: [{
        payload: {
          content: event.content.slice(0, MAX_BUDDY_MESSAGE_TEXT_LENGTH),
          contentIndex: event.contentIndex,
          kind: 'reasoning',
          messageId,
        },
        type: 'message.block.completed',
      }],
    }
  }
  if (event.type === 'text_start') {
    const phase = resolvePiTextPhase(event.partial.content[event.contentIndex])
    if (phase !== 'commentary')
      return { events: [] }
    return {
      events: [{
        payload: {
          contentIndex: event.contentIndex,
          kind: 'text',
          messageId,
          phase,
        },
        type: 'message.block.started',
      }],
    }
  }
  if (event.type === 'text_delta' && event.delta) {
    const phase = resolvePiTextPhase(event.partial.content[event.contentIndex])
    return {
      events: [{
        payload: {
          contentIndex: event.contentIndex,
          delta: event.delta.slice(0, MAX_DELTA_LENGTH),
          messageId,
          ...(phase ? { phase } : {}),
        },
        type: 'message.delta',
      }],
    }
  }
  if (event.type === 'text_end') {
    const phase = resolvePiTextPhase(event.partial.content[event.contentIndex])
    if (phase !== 'commentary')
      return { events: [] }
    state.completedCommentaryBlockIndexes.add(event.contentIndex)
    return {
      events: [{
        payload: {
          content: event.content.slice(0, MAX_BUDDY_MESSAGE_TEXT_LENGTH),
          contentIndex: event.contentIndex,
          kind: 'text',
          messageId,
          phase,
        },
        type: 'message.block.completed',
      }],
    }
  }
  return { events: [] }
}

function projectMessageEnd(
  message: SessionMessage,
  state: PiEventProjectionState,
): PiEventProjection {
  if (message.role === 'assistant')
    return projectAssistantMessageEnd(message, state)
  if (message.role === 'toolResult')
    return projectToolMessageEnd(message)
  return { events: [] }
}

function projectAssistantMessageEnd(
  message: AssistantMessage,
  state: PiEventProjectionState,
): PiEventProjection {
  const messageId = state.assistantMessageId ?? randomUUID()
  state.assistantMessageId = null
  const textBlocks = message.content.flatMap((content, contentIndex) => (
    content.type === 'text'
      ? [{ content, contentIndex, phase: resolvePiTextPhase(content) }]
      : []
  ))
  const text = selectCompletedText(textBlocks)
  const phase = resolveCompletedTextPhase(textBlocks)
    ?? (message.stopReason === 'toolUse' && text.trim() ? 'commentary' : undefined)
  const missingTextBlockEvents: BuddyProjectedEvent[] = textBlocks.flatMap((block) => {
    if (
      block.phase !== 'commentary'
      || state.completedCommentaryBlockIndexes.has(block.contentIndex)
    ) {
      return []
    }
    return [{
      payload: {
        content: block.content.text.slice(0, MAX_BUDDY_MESSAGE_TEXT_LENGTH),
        contentIndex: block.contentIndex,
        kind: 'text',
        messageId,
        phase: block.phase,
      },
      type: 'message.block.completed' as const,
    }]
  })
  state.completedCommentaryBlockIndexes.clear()
  const modelFailure = message.stopReason === 'error'
    ? normalizeModelRequestFailure(message.errorMessage)
    : null
  const failureCode = modelFailure?.code
    ?? (message.stopReason === 'aborted' ? 'MODEL_REQUEST_ABORTED' : undefined)
  const stopReason = normalizeStopReason(message.stopReason)
  return {
    events: [
      ...missingTextBlockEvents,
      {
        payload: {
          content: {
            text,
          },
          messageId,
          ...(phase ? { phase } : {}),
          role: 'assistant',
          stopReason,
        },
        type: 'message.completed',
      },
    ],
    ...(failureCode ? { failureCode } : {}),
    ...(modelFailure?.message ? { failureMessage: modelFailure.message } : {}),
    sourceMessageId: messageId,
  }
}

interface ProjectedTextBlock {
  content: TextContent
  contentIndex: number
  phase: BuddyAssistantTextPhase | undefined
}

function selectCompletedText(blocks: readonly ProjectedTextBlock[]): string {
  const selected = blocks.some(block => block.phase === 'final_answer')
    ? blocks.filter(block => block.phase === 'final_answer')
    : blocks
  return selected
    .map(block => block.content.text)
    .join('')
    .slice(0, MAX_BUDDY_MESSAGE_TEXT_LENGTH)
}

function resolveCompletedTextPhase(
  blocks: readonly ProjectedTextBlock[],
): BuddyAssistantTextPhase | undefined {
  if (blocks.some(block => block.phase === 'final_answer'))
    return 'final_answer'
  return blocks.length > 0 && blocks.every(block => block.phase === 'commentary')
    ? 'commentary'
    : undefined
}

function resolvePiTextPhase(
  content: AssistantMessage['content'][number] | undefined,
): BuddyAssistantTextPhase | undefined {
  if (content?.type !== 'text' || !content.textSignature)
    return undefined
  try {
    const signature = JSON.parse(content.textSignature) as unknown
    if (!signature || typeof signature !== 'object' || Array.isArray(signature))
      return undefined
    const record = signature as Record<string, unknown>
    if (record.v !== 1 || typeof record.id !== 'string')
      return undefined
    const phase = buddyAssistantTextPhaseSchema.safeParse(record.phase)
    return phase.success ? phase.data : undefined
  }
  catch {
    return undefined
  }
}

function normalizeModelRequestFailure(value: string | undefined): {
  code: ModelRequestFailureCode
  message?: string
} {
  const normalized = value ? redactSensitiveText(value).trim() : ''
  const message = normalized ? normalized.slice(0, MAX_FAILURE_MESSAGE_LENGTH) : undefined
  return {
    code: classifyModelRequestFailure(message),
    ...(message ? { message } : {}),
  }
}

function classifyModelRequestFailure(message: string | undefined): ModelRequestFailureCode {
  if (message === 'MODEL_INPUT_UNSUPPORTED' || message === 'MODEL_INPUT_TOO_LARGE' || message === 'RESOURCE_MATERIALIZATION_FAILED')
    return message
  if (!message)
    return 'MODEL_REQUEST_FAILED'
  if (/stream ended without (?:a )?finish(?:_| )reason/i.test(message))
    return 'MODEL_STREAM_INCOMPLETE'
  if (
    /(?:unknown|unsupported|invalid)\s+model|model.{0,80}(?:not found|does not exist|not supported|unsupported)|(?:不支持|找不到|不存在|未知).{0,20}模型|模型.{0,20}(?:不支持|找不到|不存在|未知)/i.test(message)
  ) {
    return 'MODEL_NOT_SUPPORTED'
  }
  if (/\b401\b|unauthori[sz]ed|authentication failed|invalid api[-_ ]?key|认证失败|密钥无效/i.test(message))
    return 'PROVIDER_AUTHENTICATION_FAILED'
  if (/\b403\b|forbidden|access denied|permission denied|无权访问|权限不足/i.test(message))
    return 'PROVIDER_ACCESS_DENIED'
  if (/\b429\b|too many requests|rate limit|速率限制|请求过多/i.test(message))
    return 'PROVIDER_RATE_LIMITED'
  if (/\b504\b|ETIMEDOUT|timed? out|timeout|请求超时|响应超时/i.test(message))
    return 'MODEL_REQUEST_TIMED_OUT'
  if (/\b5\d{2}\b|service unavailable|服务不可用/i.test(message))
    return 'MODEL_SERVICE_UNAVAILABLE'
  if (
    /\b404\b|ECONN(?:REFUSED|RESET)|ENOTFOUND|EAI_AGAIN|fetch failed|network error|socket hang up|unable to connect|failed to connect|无法连接|连接失败|网络错误/i.test(message)
  ) {
    return 'MODEL_SERVICE_UNREACHABLE'
  }
  return 'MODEL_REQUEST_FAILED'
}

function projectToolMessageEnd(message: ToolResultMessage): PiEventProjection {
  const messageId = randomUUID()
  return {
    events: [{
      payload: {
        content: {
          isError: message.isError,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
        },
        messageId,
        role: 'tool',
      },
      type: 'message.tool_result',
    }],
    sourceMessageId: messageId,
  }
}

function normalizeStopReason(reason: AssistantMessage['stopReason']): string {
  if (reason === 'error' || reason === 'aborted')
    return 'failed'
  if (reason === 'toolUse')
    return 'tool_use'
  if (reason === 'length')
    return 'length'
  if (reason === 'deferred')
    return 'deferred'
  return 'completed'
}
