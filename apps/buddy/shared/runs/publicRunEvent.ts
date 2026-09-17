import { z } from 'zod'
import { contextPanelOperationSchema } from '../context-panel/contextPanel'
import { BUDDY_ATTACHMENT_COUNT_LIMIT } from '../conversation/attachmentPolicy'
import {
  MAX_BUDDY_MESSAGE_TEXT_LENGTH,
  readBuddyInterruptedMessageContent,
} from '../conversation/buddyMessageContent'
import { approvalReviewPayloadSchema } from '../permissions/approvalReviewPayload'
import { buddyAssistantTextPhaseSchema } from './assistantTextPhase'
import {
  buddyToolPresentationDeltaSchema,
  buddyToolPresentationSchema,
} from './runEventPresentation'
import { buddyRunOutputPayloadSchema } from './runOutput'
import { buddyRunProgressSchema } from './runProgress'
import { isToolFailureCode } from './toolFailure'

export interface RunEventLike {
  createdAt: string
  payload: unknown
  runId: string
  sequence: number
  type: string
}

export interface PublicRunEvent extends Omit<RunEventLike, 'payload'> {
  payload: Record<string, unknown>
}

export const publicRunEventSchema = z.object({
  createdAt: z.iso.datetime(),
  payload: z.record(z.string(), z.unknown()),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: z.string().min(1),
}).strict().superRefine((event, context) => {
  if (samePublicValue(event.payload, toPublicRunEvent(event).payload))
    return
  context.addIssue({
    code: 'custom',
    message: 'Lexora Buddy public run event contains unsupported payload fields',
    path: ['payload'],
  })
})

const MAX_PUBLIC_STRING_LENGTH = 4 * 1024
const MAX_MESSAGE_DELTA_LENGTH = 64 * 1024
const SCALAR_PAYLOAD_KEYS = new Map<string, readonly string[]>([
  ['approval.requested', ['id', 'kind', 'status', 'summary', 'toolCallId']],
  ['approval.resolved', ['id', 'resolution', 'resolvedAt', 'status']],
  ['approval.turn_reused', ['sourceApprovalId', 'toolCallId', 'toolName']],
  ['approval.reused', ['scope', 'sourceApprovalId', 'toolCallId', 'toolName']],
  ['context.compaction.cancelled', ['reason', 'willRetry']],
  ['context.compaction.completed', ['estimatedTokensAfter', 'reason', 'tokensBefore', 'willRetry']],
  ['context.compaction.failed', ['errorCode', 'reason', 'willRetry']],
  ['context.compaction.started', ['reason']],
  ['context.usage.updated', [
    'mcpTokens',
    'messageTokens',
    'model',
    'provider',
    'skillTokens',
    'systemPromptTokens',
    'toolTokens',
    'totalTokens',
  ]],
  ['message.delta', ['contentIndex', 'delta', 'messageId', 'phase']],
  ['message.block.completed', ['content', 'contentIndex', 'kind', 'messageId', 'phase']],
  ['message.block.delta', ['delta', 'contentIndex', 'kind', 'messageId', 'phase']],
  ['message.block.started', ['contentIndex', 'kind', 'messageId', 'phase']],
  ['message.started', ['messageId', 'role']],
  ['run.cancelled', ['errorCode']],
  ['run.completed', ['errorCode']],
  ['run.failed', ['errorCode', 'errorMessage']],
  ['run.started', []],
  ['session.continuity.degraded', ['errorCode', 'source']],
  ['session.recovered', ['source']],
  ['session.recovery.degraded', [
    'missingAttachmentCount',
    'recoveredImageCount',
    'source',
  ]],
  ['tool.completed', ['isError', 'toolCallId', 'toolName']],
  ['tool.denied', ['toolCallId', 'toolName']],
  ['tool.failed', ['toolCallId', 'toolName']],
  ['tool.preparing', ['toolCallId', 'toolName']],
  ['tool.started', ['toolCallId', 'toolName']],
  ['tool.updated', ['macro', 'status', 'toolCallId', 'toolName']],
  ['usage.recording.degraded', ['errorCode', 'purpose']],
  ['usage.recorded', [
    'cacheReadTokens',
    'cacheWriteTokens',
    'inputTokens',
    'model',
    'outputTokens',
    'provider',
    'purpose',
    'reasoningTokens',
    'totalCost',
    'totalTokens',
    'usageRecordId',
  ]],
])

export function toPublicRunEvent(event: RunEventLike): PublicRunEvent {
  return {
    createdAt: event.createdAt,
    payload: publicPayload(event.type, event.payload),
    runId: event.runId,
    sequence: event.sequence,
    type: event.type,
  }
}

function publicPayload(type: string, value: unknown): Record<string, unknown> {
  const source = readRecord(value)
  if (!source)
    return {}
  if (type === 'approval.requested')
    return publicApprovalRequest(source)
  if (type === 'message.completed')
    return publicCompletedMessage(source)
  if (type === 'message.interrupted')
    return publicInterruptedMessage(source)
  if (type === 'run.progress')
    return publicRunProgress(source)
  if (type === 'desktop.panel.changed') {
    const operation = contextPanelOperationSchema.safeParse({ action: source.action, actor: source.actor })
    return operation.success ? operation.data : {}
  }
  if (type === 'output.produced') {
    const output = buddyRunOutputPayloadSchema.safeParse({
      artifactIds: source.artifactIds,
      sourceToolCallId: source.sourceToolCallId,
      sourceToolName: source.sourceToolName,
    })
    return output.success ? output.data : {}
  }
  if (type === 'tool.denied')
    return publicToolDenial(source)
  if (type === 'tool.failed') {
    const published = selectScalars(source, ['toolCallId', 'toolName'])
    if (isToolFailureCode(source.errorCode))
      published.errorCode = source.errorCode
    return published
  }
  if (
    type === 'tool.preparing'
    || type === 'tool.started'
    || type === 'tool.updated'
    || type === 'tool.completed'
  ) {
    return publicToolEvent(source, type)
  }
  const keys = SCALAR_PAYLOAD_KEYS.get(type)
  if (!keys)
    return {}
  return selectScalars(source, keys)
}

const PUBLIC_DENIAL_CODES = new Set([
  'APPROVAL_DENIED',
  'APPROVAL_UNAVAILABLE_IN_BACKGROUND',
  'DIRECTORY_GRANT_FAILED',
  'INVALID_PATH',
  'PATH_NOT_FOUND',
  'MULTIPLE_DIRECTORY_GRANTS_REQUIRED',
  'READ_ONLY_PROFILE',
  'SENSITIVE_PATH',
  'VALIDATION_FAILED',
])

function publicToolDenial(source: Record<string, unknown>): Record<string, unknown> {
  const published = selectScalars(source, ['toolCallId', 'toolName'])
  const code = source.denialCode
  if (typeof code === 'string' && PUBLIC_DENIAL_CODES.has(code))
    published.denialCode = code
  return published
}

function publicRunProgress(source: Record<string, unknown>): Record<string, unknown> {
  const progress = buddyRunProgressSchema.safeParse({
    phase: source.phase,
    toolName: source.toolName ?? null,
  })
  return progress.success ? progress.data : {}
}

function publicApprovalRequest(source: Record<string, unknown>): Record<string, unknown> {
  const payload = selectScalars(source, ['id', 'kind', 'status', 'summary', 'toolCallId'])
  const review = approvalReviewPayloadSchema.safeParse(source.review ?? source.payload)
  if (review.success)
    payload.review = review.data
  return payload
}

function publicToolEvent(
  source: Record<string, unknown>,
  type: 'tool.completed' | 'tool.preparing' | 'tool.started' | 'tool.updated',
): Record<string, unknown> {
  const presentation = buddyToolPresentationSchema.safeParse(source.presentation)
  const payload = selectScalars(source, [
    ...(type === 'tool.completed' ? ['isError'] : []),
    'toolCallId',
    'toolLabel',
    'toolName',
  ])
  if (presentation.success) {
    payload.presentation = presentation.data
  }
  else if (type === 'tool.updated') {
    const sourceDelta = readRecord(source.presentationDelta)
    const presentationDelta = buddyToolPresentationDeltaSchema.safeParse({
      card: sourceDelta?.card,
      outputDelta: sourceDelta?.outputDelta,
      outputStart: sourceDelta?.outputStart,
      truncated: sourceDelta?.truncated,
    })
    if (presentationDelta.success)
      payload.presentationDelta = presentationDelta.data
  }
  return payload
}

function publicInterruptedMessage(source: Record<string, unknown>): Record<string, unknown> {
  const payload = selectScalars(source, ['messageId', 'reason', 'role'])
  const sourceContent = readRecord(source.content)
  const content = sourceContent
    ? readBuddyInterruptedMessageContent({
        state: sourceContent.state,
        text: sourceContent.text,
        truncated: sourceContent.truncated,
      })
    : null
  if (content)
    payload.content = content
  return payload
}

function publicCompletedMessage(source: Record<string, unknown>): Record<string, unknown> {
  const payload = selectScalars(source, ['messageId', 'phase', 'role', 'stopReason'])
  const content = readRecord(source.content)
  if (content && typeof content.text === 'string') {
    const attachmentIds = Array.isArray(content.attachmentIds)
      ? content.attachmentIds
          .filter((id): id is string => typeof id === 'string' && Boolean(id))
          .slice(0, BUDDY_ATTACHMENT_COUNT_LIMIT)
      : []
    payload.content = {
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      text: content.text.slice(0, MAX_BUDDY_MESSAGE_TEXT_LENGTH),
    }
  }
  return payload
}

function selectScalars(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const selected: Record<string, unknown> = {}
  for (const key of keys) {
    const value = toPublicScalar(key, source[key])
    if (value !== undefined)
      selected[key] = value
  }
  return selected
}

function toPublicScalar(
  key: string,
  value: unknown,
): boolean | null | number | string | undefined {
  if (key === 'toolLabel')
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : undefined
  if (key === 'phase') {
    const phase = buddyAssistantTextPhaseSchema.safeParse(value)
    return phase.success ? phase.data : undefined
  }
  if (typeof value === 'string') {
    return value.slice(
      0,
      key === 'delta'
        ? MAX_MESSAGE_DELTA_LENGTH
        : key === 'content'
          ? MAX_BUDDY_MESSAGE_TEXT_LENGTH
          : MAX_PUBLIC_STRING_LENGTH,
    )
  }
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined
  return value === null || typeof value === 'boolean' ? value : undefined
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function samePublicValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right))
    return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => samePublicValue(value, right[index]))
  }
  const leftRecord = readRecord(left)
  const rightRecord = readRecord(right)
  if (!leftRecord || !rightRecord)
    return false
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && samePublicValue(leftRecord[key], rightRecord[key])
    ))
}
