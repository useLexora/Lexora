import type { DatabaseSync } from 'node:sqlite'
import type { BuddyRunEvent } from '../events/BuddyRunEvent'
import type { ProductQueries } from './ProductQueries'

export function projectProductTurnChange(queries: ProductQueries, database: DatabaseSync, scope: { conversationId: string, branchId: string, executionKind: string }, event: BuddyRunEvent): unknown[] {
  const { conversationId, branchId, executionKind } = scope
  const { runId, sequence, createdAt, type } = event
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {}
  const messageId = typeof payload.messageId === 'string' ? payload.messageId : null
  const upsert = (entity: string, value: unknown) => ({ kind: 'upsert', item: { entity, value } })
  if ((type === 'approval.requested' || type === 'approval.resolved') && typeof payload.id === 'string') {
    const value = queries.views.approvalHeader(payload.id)
    return value && value.conversationId === conversationId && value.branchId === branchId && value.runId === runId ? [upsert('approval', value)] : []
  }
  if (executionKind === 'npc_child')
    return []
  if (['run.queued', 'run.started', 'run.completed', 'run.failed', 'run.cancelled'].includes(type)) {
    const run = queries.readRun(runId)
    if (!run)
      return []
    const changes = [upsert('run', run)]
    if (type === 'run.queued' && executionKind === 'root') {
      const message = queries.turnMessage(conversationId, branchId, run.triggeringMessageId, runId)
      if (message?.role === 'user')
        changes.push(upsert('message', message))
    }
    if (executionKind === 'root' && ['run.failed', 'run.cancelled', 'run.completed'].includes(type)) {
      for (const group of queries.turns.interruptedGroups({ conversationId, branchId, runId }))
        changes.push(upsert('activityGroup', group))
    }
    return changes
  }
  if (messageId && (type === 'message.completed' || type === 'message.interrupted' || type === 'message.created')) {
    const message = queries.turnMessage(conversationId, branchId, messageId, runId)
    const changes = message && (message.runId === runId || (message.role === 'user' && message.runId === null)) ? [upsert('message', message)] : []
    if (executionKind === 'root' && type !== 'message.created') {
      for (const group of queries.turns.reasoningGroupsForMessage({ conversationId, branchId, runId, messageId }))
        changes.push(upsert('activityGroup', group))
    }
    return changes
  }
  if (type === 'output.produced' && database.prepare(`SELECT 1 FROM conversation_publications WHERE conversation_id = ? AND branch_id = ? AND run_id = ? AND source_sequence = ? AND kind = 'output'`).get(conversationId, branchId, runId, sequence))
    return [{ kind: 'event', event: { runId, sequence: String(sequence), type, createdAt, detail: { kind: 'status' } } }]
  if (executionKind !== 'root')
    return []
  if (type === 'message.started' && payload.role === 'assistant' && messageId) {
    const message = queries.streaming.turnStart(runId, messageId, createdAt, sequence)
    return message ? [upsert('message', { ...message, ...queries.turns.binding({ conversationId, branchId, runId, messageId }) })] : []
  }
  if (type === 'message.delta' && messageId) {
    const change = queries.streaming.turnAppend(runId, messageId, sequence)
    return change ? [change] : []
  }
  if ((type === 'message.block.started' || type === 'message.block.completed') && payload.kind === 'reasoning' && messageId && typeof payload.contentIndex === 'number' && Number.isSafeInteger(payload.contentIndex) && payload.contentIndex >= 0) {
    const group = queries.turns.groupForReasoning({ conversationId, branchId, runId, messageId, contentIndex: payload.contentIndex })
    return group ? [upsert('activityGroup', group)] : []
  }
  if (['tool.preparing', 'tool.started', 'tool.completed', 'tool.failed', 'tool.denied', 'message.tool_result'].includes(type)) {
    const body = type === 'message.tool_result' && payload.content && typeof payload.content === 'object' ? payload.content as Record<string, unknown> : payload
    if (typeof body.toolCallId === 'string') {
      const group = queries.turns.groupForCall({ conversationId, branchId, runId, toolCallId: body.toolCallId })
      if (group)
        return [upsert('activityGroup', group)]
    }
  }
  return []
}
