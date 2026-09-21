import type { DatabaseSync } from 'node:sqlite'
import type { BuddyRunEvent } from './BuddyRunEvent'
import { z } from 'zod'
import { BUDDY_ATTACHMENT_COUNT_LIMIT } from '../../../shared/conversation/attachmentPolicy'
import { MAX_BUDDY_MESSAGE_TEXT_LENGTH } from '../../../shared/conversation/buddyMessageContent'
import {
  APPROVAL_REVIEW_KINDS,
  approvalReviewPayloadMatchesKind,
  approvalReviewPayloadSchema,
} from '../../../shared/permissions/approvalReviewPayload'
import { buddyAssistantTextPhaseSchema } from '../../../shared/runs/assistantTextPhase'
import { withTransaction } from '../storage/database'
import { buddyRunIdSchema, terminalRunStatus } from './BuddyRunEvent'

const messageIdSchema = z.string().min(1).max(256)
const approvalRequestPayloadSchema = z.object({
  createdAt: z.iso.datetime(),
  id: z.string().min(1),
  kind: z.enum(APPROVAL_REVIEW_KINDS),
  payload: approvalReviewPayloadSchema,
  resolvedAt: z.null(),
  runId: buddyRunIdSchema,
  status: z.literal('pending'),
  summary: z.string(),
  toolCallId: z.string().min(1),
}).strict().refine(
  approval => approvalReviewPayloadMatchesKind(approval.payload, approval.kind),
  { path: ['payload'] },
)
const approvalResolutionPayloadSchema = z.object({
  id: z.string().min(1),
  resolution: z.enum(['approved', 'approved_for_operation', 'approved_for_source', 'approved_for_turn', 'cancelled', 'denied']).optional(),
  resolvedAt: z.iso.datetime(),
  status: z.enum(['approved', 'denied', 'cancelled']),
}).strict()
const usageEventPayloadSchema = z.object({
  cacheReadCost: z.number().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteCost: z.number().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  inputCost: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  model: z.string().min(1),
  outputCost: z.number().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  provider: z.string().min(1),
  purpose: z.enum(['cache_warm', 'compaction', 'tool', 'turn']),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  sourceEntryId: z.string().min(1),
  totalCost: z.number().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  usageRecordId: z.string().min(1),
}).strict()
const completedMessagePayloadSchema = z.object({
  content: z.object({
    attachmentIds: z.array(messageIdSchema).max(BUDDY_ATTACHMENT_COUNT_LIMIT).optional(),
    text: z.string().max(MAX_BUDDY_MESSAGE_TEXT_LENGTH),
  }).strict(),
  messageId: messageIdSchema,
  phase: buddyAssistantTextPhaseSchema.optional(),
  role: z.literal('assistant'),
  stopReason: z.enum(['completed', 'deferred', 'failed', 'length', 'tool_use']),
}).strict()
const toolResultMessagePayloadSchema = z.object({
  content: z.object({
    isError: z.boolean(),
    toolCallId: z.string().min(1).max(256),
    toolName: z.string().min(1).max(256),
  }).strict(),
  messageId: messageIdSchema,
  role: z.literal('tool'),
}).strict()
const interruptedMessagePayloadSchema = z.object({
  content: z.object({
    state: z.literal('interrupted'),
    text: z.string().max(MAX_BUDDY_MESSAGE_TEXT_LENGTH),
    truncated: z.boolean(),
  }).strict(),
  messageId: messageIdSchema,
  reason: z.literal('runtime_restarted'),
  role: z.literal('assistant'),
}).strict()

interface ApprovalFactState {
  runId: string
  status: 'approved' | 'cancelled' | 'denied' | 'pending'
}

interface ProductMessageProjection {
  conflictKind: 'completed' | 'interrupted' | 'tool result'
  content: Record<string, unknown>
  messageId: string
  role: 'assistant' | 'tool'
}

type ApprovalRequestProjection = z.infer<typeof approvalRequestPayloadSchema>
type ApprovalResolutionProjection = z.infer<typeof approvalResolutionPayloadSchema>
type UsageProjection = z.infer<typeof usageEventPayloadSchema>

export class RunEventProjector {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
  }

  project(events: readonly BuddyRunEvent[]): number {
    return withTransaction(this.#database, () => events.reduce(
      (count, event) => count + this.#project(event),
      0,
    ))
  }

  rebuild(runId: string, events: readonly BuddyRunEvent[]): number {
    return withTransaction(this.#database, () => {
      const messageIds = new Set<string>()
      for (const event of events) {
        if (event.runId !== runId)
          throw new Error('Replayed events must belong to one run')
        const message = parseProductMessage(event)
        if (!message)
          continue
        if (messageIds.has(message.messageId))
          throw new Error(`Duplicate replayed message: ${message.messageId}`)
        messageIds.add(message.messageId)
      }
      this.#database.prepare('DELETE FROM run_events WHERE run_id = ?').run(runId)
      this.#database.prepare('DELETE FROM approvals WHERE run_id = ?').run(runId)
      this.#database.prepare('DELETE FROM usage_records WHERE run_id = ?').run(runId)
      const count = events.reduce(
        (count, event) => count + this.#project(event, 'rebuild'),
        0,
      )
      const projected = this.#database.prepare(`
        SELECT id FROM messages WHERE run_id = ? AND role IN ('assistant', 'tool')
      `).all(runId) as Array<{ id: string }>
      const remove = this.#database.prepare('DELETE FROM messages WHERE id = ? AND run_id = ?')
      for (const message of projected) {
        if (!messageIds.has(message.id))
          remove.run(message.id, runId)
      }
      return count
    })
  }

  removeEventRows(runId: string, sequences: readonly number[]): void {
    withTransaction(this.#database, () => {
      const remove = this.#database.prepare(`
        DELETE FROM run_events WHERE run_id = ? AND sequence = ?
      `)
      for (const sequence of sequences)
        remove.run(runId, sequence)
    })
  }

  validateNewFacts(events: readonly BuddyRunEvent[]): void {
    const runId = events[0]!.runId
    if (!this.#runExists(runId))
      throw new Error(`Lexora Buddy run event conflicts with storage: ${runId}`)

    const messageIds = new Set<string>()
    const approvalStates = new Map<string, ApprovalFactState>()
    const usageRecordIds = new Set<string>()
    const usageSourceKeys = new Set<string>()
    const findMessage = this.#database.prepare('SELECT 1 FROM messages WHERE id = ?')
    const findApproval = this.#database.prepare(`
      SELECT run_id AS runId, status FROM approvals WHERE id = ?
    `)
    const findUsageById = this.#database.prepare('SELECT 1 FROM usage_records WHERE id = ?')
    const findUsageBySource = this.#database.prepare(`
      SELECT 1 FROM usage_records
      WHERE run_id = ? AND source_entry_id = ? AND purpose = ?
    `)
    for (const event of events) {
      const message = parseProductMessage(event)
      if (message && (messageIds.has(message.messageId) || findMessage.get(message.messageId))) {
        throw new Error(
          `Lexora Buddy ${message.conflictKind} message conflicts with storage: ${message.messageId}`,
        )
      }
      if (message)
        messageIds.add(message.messageId)

      const approval = parseApprovalRequest(event)
      if (approval) {
        if (approvalStates.has(approval.id) || findApproval.get(approval.id))
          throw approvalConflict(approval.id)
        approvalStates.set(approval.id, { runId, status: 'pending' })
      }

      const resolution = parseApprovalResolution(event)
      if (resolution) {
        const approvalState = approvalStates.get(resolution.id)
          ?? findApproval.get(resolution.id) as ApprovalFactState | undefined
        if (
          !approvalState
          || approvalState.runId !== runId
          || approvalState.status !== 'pending'
        ) {
          throw approvalConflict(resolution.id)
        }
        approvalStates.set(resolution.id, { runId, status: resolution.status })
      }

      const usage = parseUsage(event)
      if (usage) {
        const sourceKey = JSON.stringify([runId, usage.sourceEntryId, usage.purpose])
        if (
          usageRecordIds.has(usage.usageRecordId)
          || usageSourceKeys.has(sourceKey)
          || findUsageById.get(usage.usageRecordId)
          || findUsageBySource.get(runId, usage.sourceEntryId, usage.purpose)
        ) {
          throw usageConflict(usage.usageRecordId)
        }
        usageRecordIds.add(usage.usageRecordId)
        usageSourceKeys.add(sourceKey)
      }
    }
  }

  #project(event: BuddyRunEvent, mode: 'append' | 'rebuild' = 'append'): number {
    const result = this.#database.prepare(`
      INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (run_id, sequence) DO NOTHING
    `).run(
      event.runId,
      event.sequence,
      event.type,
      JSON.stringify(event.payload),
      event.createdAt,
    )
    projectRunStatus(this.#database, event)
    projectProductMessage(this.#database, event, mode)
    projectApprovalRequest(this.#database, event)
    projectApprovalResolution(this.#database, event)
    projectUsage(this.#database, event)
    return Number(result.changes)
  }

  #runExists(runId: string): boolean {
    return this.#database.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId) !== undefined
  }
}

function projectRunStatus(database: DatabaseSync, event: BuddyRunEvent): void {
  const status = terminalRunStatus(event.type)
  if (status) {
    database.prepare(`
      UPDATE runs SET status = ?, completed_at = ?, error_code = ? WHERE id = ?
    `).run(status, event.createdAt, readTerminalErrorCode(event.payload), event.runId)
    return
  }

  if (event.type === 'run.started') {
    database.prepare(`
      UPDATE runs
      SET status = 'running', started_at = ?, completed_at = NULL, error_code = NULL
      WHERE id = ?
    `).run(event.createdAt, event.runId)
  }
}

function projectProductMessage(database: DatabaseSync, event: BuddyRunEvent, mode: 'append' | 'rebuild'): void {
  const message = parseProductMessage(event)
  if (!message)
    return
  const contentJson = JSON.stringify(message.content)
  const result = database.prepare(`
    INSERT INTO messages (
      id, conversation_id, branch_id, run_id, role, content_json, created_at
    )
    SELECT ?, runs.conversation_id, runs.branch_id, runs.id, ?, ?, ?
    FROM runs
    WHERE runs.id = ?
    ON CONFLICT (id) DO UPDATE SET
      content_json = excluded.content_json, created_at = excluded.created_at
    WHERE ? AND messages.run_id = excluded.run_id
      AND messages.conversation_id = excluded.conversation_id
      AND messages.branch_id = excluded.branch_id AND messages.role = excluded.role
  `).run(message.messageId, message.role, contentJson, event.createdAt, event.runId, Number(mode === 'rebuild'))
  if (Number(result.changes) === 1)
    return
  throw new Error(
    `Lexora Buddy ${message.conflictKind} message conflicts with storage: ${message.messageId}`,
  )
}

function parseProductMessage(event: BuddyRunEvent): ProductMessageProjection | null {
  if (event.type === 'message.completed') {
    const message = completedMessagePayloadSchema.parse(event.payload)
    return { ...message, conflictKind: 'completed' }
  }
  if (event.type === 'message.tool_result') {
    const message = toolResultMessagePayloadSchema.parse(event.payload)
    return { ...message, conflictKind: 'tool result' }
  }
  if (event.type === 'message.interrupted') {
    const message = interruptedMessagePayloadSchema.parse(event.payload)
    return { ...message, conflictKind: 'interrupted' }
  }
  return null
}

function parseApprovalRequest(event: BuddyRunEvent): ApprovalRequestProjection | null {
  if (event.type !== 'approval.requested')
    return null
  const approval = approvalRequestPayloadSchema.parse(event.payload)
  if (approval.runId !== event.runId)
    throw new Error(`Lexora Buddy approval event is invalid: ${event.runId}`)
  return approval
}

function parseApprovalResolution(event: BuddyRunEvent): ApprovalResolutionProjection | null {
  return event.type === 'approval.resolved'
    ? approvalResolutionPayloadSchema.parse(event.payload)
    : null
}

function parseUsage(event: BuddyRunEvent): UsageProjection | null {
  return event.type === 'usage.recorded'
    ? usageEventPayloadSchema.parse(event.payload)
    : null
}

function approvalConflict(id: string): Error {
  return new Error(`Lexora Buddy approval event conflicts with storage: ${id}`)
}

function usageConflict(id: string): Error {
  return new Error(`Lexora Buddy usage event conflicts with storage: ${id}`)
}

function projectApprovalResolution(database: DatabaseSync, event: BuddyRunEvent): void {
  const resolution = parseApprovalResolution(event)
  if (!resolution)
    return
  const result = database.prepare(`
    UPDATE approvals SET status = ?, resolved_at = ?
    WHERE id = ? AND run_id = ? AND status = 'pending'
  `).run(resolution.status, resolution.resolvedAt, resolution.id, event.runId)
  if (Number(result.changes) === 1)
    return
  throw approvalConflict(resolution.id)
}

function projectApprovalRequest(database: DatabaseSync, event: BuddyRunEvent): void {
  const approval = parseApprovalRequest(event)
  if (!approval)
    return
  const payloadJson = JSON.stringify(approval.payload)
  if (payloadJson === undefined)
    throw new Error(`Lexora Buddy approval event is invalid: ${event.runId}`)
  const result = database.prepare(`
    INSERT INTO approvals (
      id, run_id, tool_call_id, kind, status, summary, payload_json, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL)
    ON CONFLICT (id) DO NOTHING
  `).run(
    approval.id,
    approval.runId,
    approval.toolCallId,
    approval.kind,
    approval.summary,
    payloadJson,
    approval.createdAt,
  )
  if (Number(result.changes) === 1)
    return
  throw approvalConflict(approval.id)
}

function projectUsage(database: DatabaseSync, event: BuddyRunEvent): void {
  const usage = parseUsage(event)
  if (!usage)
    return
  const result = database.prepare(`
    INSERT INTO usage_records (
      id, run_id, source_entry_id, provider, model, purpose,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reasoning_tokens, total_tokens, input_cost, output_cost,
      cache_read_cost, cache_write_cost, total_cost, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(
    usage.usageRecordId,
    event.runId,
    usage.sourceEntryId,
    usage.provider,
    usage.model,
    usage.purpose,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.reasoningTokens,
    usage.totalTokens,
    usage.inputCost,
    usage.outputCost,
    usage.cacheReadCost,
    usage.cacheWriteCost,
    usage.totalCost,
    event.createdAt,
  )
  if (Number(result.changes) === 1)
    return
  throw usageConflict(usage.usageRecordId)
}

function readTerminalErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null
  const errorCode = (payload as Record<string, unknown>).errorCode
  return typeof errorCode === 'string' && errorCode.length > 0 ? errorCode : null
}
