import type { DatabaseSync } from 'node:sqlite'
import type { ExecutionMailboxMessage, ExecutionMailboxReceipt } from '../../../shared/executions/executionApi'
import type { BuddyRunEvent } from '../events/BuddyRunEvent'
import { createHash } from 'node:crypto'
import { executionMailboxEventSchemas, executionMailboxMessageSchema } from '../../../shared/executions/executionApi'

export type MailboxDeliveryState = 'pending' | 'accepted' | 'consumed' | 'undelivered'

export interface ExecutionMailboxRecord {
  message: ExecutionMailboxMessage
  state: MailboxDeliveryState
  receipt: ExecutionMailboxReceipt | null
}

export function hashExecutionMailboxMessage(message: Omit<ExecutionMailboxMessage, 'payloadHash'> & { questionId?: string }): string {
  return createHash('sha256').update(JSON.stringify({
    messageId: message.messageId,
    sourceRunId: message.sourceRunId,
    sourceSequence: message.sourceSequence,
    targetRunId: message.targetRunId,
    targetGeneration: message.targetGeneration,
    kind: message.kind,
    text: message.text,
    ...('questionId' in message ? { questionId: message.questionId } : {}),
    ...('audience' in message ? { audience: message.audience } : {}),
    ...('origin' in message ? { origin: message.origin } : {}),
    ...('purpose' in message ? { purpose: message.purpose } : {}),
  })).digest('hex')
}

export function createMailboxRepository(database: DatabaseSync) {
  function findSource(messageId: string): ExecutionMailboxMessage | null {
    const row = database.prepare('SELECT payload_json FROM execution_mailbox_sources WHERE id = ?').get(messageId)
    return row ? executionMailboxMessageSchema.parse(JSON.parse(row.payload_json as string)) : null
  }

  function receiptRows(messageId: string) {
    return database.prepare('SELECT * FROM execution_mailbox_receipts WHERE mailbox_id = ? ORDER BY target_sequence').all(messageId)
  }

  function assertIdentity(messageId: string, sourceRunId: string, targetRunId: string, payloadHash: string): void {
    const source = findSource(messageId)
    if (source && (source.sourceRunId !== sourceRunId || source.targetRunId !== targetRunId || source.payloadHash !== payloadHash))
      throw new Error('Mailbox identity conflicts with source fact')
    for (const row of receiptRows(messageId)) {
      if (row.source_run_id !== sourceRunId || row.target_run_id !== targetRunId || row.payload_hash !== payloadHash)
        throw new Error('Mailbox identity conflicts with target fact')
    }
    const sourceRun = database.prepare('SELECT root_run_id, conversation_id FROM runs WHERE id = ?').get(sourceRunId)
    const targetRun = database.prepare('SELECT root_run_id, conversation_id FROM runs WHERE id = ?').get(targetRunId)
    if (!sourceRun || !targetRun || sourceRun.root_run_id !== targetRun.root_run_id || sourceRun.conversation_id !== targetRun.conversation_id)
      throw new Error('Mailbox must remain inside one execution tree')
  }

  function canAccept(message: ExecutionMailboxMessage): boolean {
    return !!database.prepare(`
      WITH RECURSIVE chain(id, parent_run_id) AS (
        SELECT id, parent_run_id FROM runs WHERE id = ?
        UNION ALL SELECT ancestor.id, ancestor.parent_run_id FROM runs ancestor JOIN chain ON ancestor.id = chain.parent_run_id
      )
      SELECT 1 FROM runs target
      JOIN execution_state state ON state.run_id = target.id
      JOIN runs root ON root.id = target.root_run_id
      JOIN execution_state root_state ON root_state.run_id = root.id
      JOIN conversations ON conversations.id = target.conversation_id
      WHERE target.id = ? AND target.generation = ? AND target.status IN ('queued', 'running')
        AND state.phase NOT IN ('closing', 'closed') AND state.cancel_requested_at IS NULL
        AND root.status IN ('queued', 'running') AND root_state.phase NOT IN ('closing', 'closed') AND root_state.cancel_requested_at IS NULL
        AND conversations.deleted_at IS NULL AND conversations.active_branch_id = target.branch_id
        AND NOT EXISTS (SELECT 1 FROM chain JOIN runs ancestor ON ancestor.id = chain.id JOIN execution_state ancestor_state ON ancestor_state.run_id = ancestor.id
          LEFT JOIN runs parent ON parent.id = ancestor.parent_run_id
          WHERE ancestor_state.phase IN ('closing', 'closed') OR ancestor_state.cancel_requested_at IS NOT NULL
            OR (parent.id IS NOT NULL AND ancestor_state.admitted_parent_generation <> parent.generation)
            OR (parent.id IS NOT NULL AND ancestor_state.admitted_root_generation <> root.generation))
    `).get(message.targetRunId, message.targetRunId, message.targetGeneration)
  }

  function validate(event: BuddyRunEvent, replay = false, acceptedInBatch = false): void {
    const schema = executionMailboxEventSchemas[event.type as keyof typeof executionMailboxEventSchemas]
    if (!schema)
      return
    const payload = schema.parse(event.payload)
    const targetRunId = event.type === 'execution.mailbox.sent' ? (payload as ExecutionMailboxMessage).targetRunId : event.runId
    assertIdentity(payload.messageId, payload.sourceRunId, targetRunId, payload.payloadHash)
    if (event.type === 'execution.mailbox.sent') {
      if (!replay && database.prepare('SELECT phase FROM execution_state WHERE run_id = ?').get(event.runId)?.phase === 'closed')
        throw new Error('Closed execution cannot publish a new mailbox source')
      const message = payload as ExecutionMailboxMessage
      if (message.sourceRunId !== event.runId || message.sourceSequence !== event.sequence || hashExecutionMailboxMessage(message) !== message.payloadHash)
        throw new Error('Mailbox source envelope does not match its durable event')
      const existing = findSource(message.messageId)
      if (existing && JSON.stringify(existing) !== JSON.stringify(message))
        throw new Error('Mailbox source conflicts with persisted envelope')
      return
    }
    const previous = receiptRows(payload.messageId)
    const kind = event.type.slice('execution.mailbox.'.length)
    if (previous.some(row => row.kind === 'rejected') && kind !== 'rejected')
      throw new Error('Rejected mailbox cannot be accepted')
    if (kind === 'rejected' && previous.some(row => row.kind !== 'rejected'))
      throw new Error('Accepted mailbox cannot be rejected')
    if ('contextEntryId' in payload && previous.some(row => row.context_entry_id !== null && row.context_entry_id !== payload.contextEntryId))
      throw new Error('Mailbox context marker conflicts with receipt')
    if (kind === 'consumed' && !acceptedInBatch && !previous.some(row => row.kind === 'accepted'))
      throw new Error('Mailbox consumption requires its accepted context marker')
    if (!replay && kind !== 'rejected') {
      const source = findSource(payload.messageId)
      if (!source || !canAccept(source))
        throw new Error('Mailbox target cannot accept this generation')
    }
  }

  function project(event: BuddyRunEvent): void {
    const schema = executionMailboxEventSchemas[event.type as keyof typeof executionMailboxEventSchemas]
    if (!schema)
      return
    validate(event, true)
    const payload = schema.parse(event.payload)
    if (event.type === 'execution.mailbox.sent') {
      const message = payload as ExecutionMailboxMessage
      database.prepare('INSERT INTO execution_mailbox_sources (id, source_run_id, source_sequence, target_run_id, target_generation, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
        .run(message.messageId, event.runId, event.sequence, message.targetRunId, message.targetGeneration, JSON.stringify(message), message.payloadHash, event.createdAt)
      return
    }
    const kind = event.type.slice('execution.mailbox.'.length)
    const existing = receiptRows(payload.messageId).find(row => row.kind === kind)
    if (existing && (existing.context_entry_id !== ('contextEntryId' in payload ? payload.contextEntryId : null) || existing.reason !== ('reason' in payload ? payload.reason : null)))
      throw new Error('Mailbox target fact conflicts with persisted receipt')
    database.prepare('INSERT INTO execution_mailbox_receipts (mailbox_id, target_run_id, target_sequence, source_run_id, payload_hash, kind, context_entry_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mailbox_id, kind) DO NOTHING')
      .run(payload.messageId, event.runId, event.sequence, payload.sourceRunId, payload.payloadHash, kind, 'contextEntryId' in payload ? payload.contextEntryId : null, 'reason' in payload ? payload.reason : null, event.createdAt)
  }

  function find(messageId: string): ExecutionMailboxRecord | null {
    const message = findSource(messageId)
    if (!message)
      return null
    const rows = receiptRows(messageId)
    const receipt = rows.find(row => row.kind === 'accepted' || row.kind === 'consumed')
    const state: MailboxDeliveryState = rows.some(row => row.kind === 'consumed')
      ? 'consumed'
      : rows.some(row => row.kind === 'rejected') || !canAccept(message)
        ? 'undelivered'
        : receipt ? 'accepted' : 'pending'
    return {
      message,
      state,
      receipt: receipt
        ? {
            messageId,
            sourceRunId: receipt.source_run_id as string,
            payloadHash: receipt.payload_hash as string,
            contextEntryId: receipt.context_entry_id as string,
          }
        : null,
    }
  }

  return {
    find,
    listInputPage(runIds: readonly string[], options: { offset: number, limit: number }) {
      const rows = database.prepare(`
        SELECT id, created_at, length(CAST(payload_json AS BLOB)) AS payload_bytes FROM execution_mailbox_sources
        WHERE target_run_id IN (${runIds.map(() => '?').join(', ')})
          AND json_extract(payload_json, '$.kind') IN ('supplement', 'answer')
        ORDER BY rowid LIMIT ? OFFSET ?
      `).all(...runIds, options.limit + 1, options.offset)
      let bytes = 0
      let count = 0
      for (const row of rows.slice(0, options.limit)) {
        if (count > 0 && bytes + Number(row.payload_bytes) > 1024 * 1024)
          break
        bytes += Number(row.payload_bytes)
        count++
      }
      return {
        records: rows.slice(0, count).map(row => ({ ...find(row.id as string)!, createdAt: row.created_at as string })),
        hasMore: rows.length > count,
      }
    },
    findQuestion(questionId: string) {
      const question = database.prepare('SELECT id FROM execution_mailbox_sources WHERE json_extract(payload_json, \'$.kind\') = \'question\' AND json_extract(payload_json, \'$.questionId\') = ?').get(questionId)
      if (!question)
        return null
      const record = find(question.id as string)!
      const answer = database.prepare('SELECT id FROM execution_mailbox_sources WHERE json_extract(payload_json, \'$.kind\') = \'answer\' AND json_extract(payload_json, \'$.questionId\') = ?').get(questionId)
      const source = database.prepare('SELECT phase, cancel_requested_at FROM execution_state WHERE run_id = ?').get(record.message.sourceRunId)
      return { ...record, answer: answer ? find(answer.id as string)!.message : null, open: !answer && source?.phase !== 'closing' && source?.phase !== 'closed' && source?.cancel_requested_at === null && canAccept(record.message) }
    },
    listQuestions(sourceRunId: string): ExecutionMailboxMessage[] {
      return database.prepare('SELECT id FROM execution_mailbox_sources WHERE source_run_id = ? AND json_extract(payload_json, \'$.kind\') = \'question\' ORDER BY source_sequence').all(sourceRunId).map(row => findSource(row.id as string)!)
    },
    validate,
    validateNewFacts(events: readonly BuddyRunEvent[]): void {
      const pending = new Map<string, { sourceRunId: string, targetRunId: string, payloadHash: string, contextEntryId?: string, rejected: boolean }>()
      for (const event of events) {
        const schema = executionMailboxEventSchemas[event.type as keyof typeof executionMailboxEventSchemas]
        if (!schema)
          continue
        const payload = schema.parse(event.payload)
        validate(event, false, pending.get(payload.messageId)?.contextEntryId !== undefined)
        const targetRunId = 'targetRunId' in payload ? payload.targetRunId : event.runId
        const previous = pending.get(payload.messageId)
        const rejected = event.type === 'execution.mailbox.rejected'
        const contextEntryId = 'contextEntryId' in payload ? payload.contextEntryId : undefined
        if (previous && (previous.sourceRunId !== payload.sourceRunId || previous.targetRunId !== targetRunId || previous.payloadHash !== payload.payloadHash
          || previous.rejected !== rejected || (previous.contextEntryId && contextEntryId && previous.contextEntryId !== contextEntryId))) {
          throw new Error('Mailbox batch facts conflict')
        }
        pending.set(payload.messageId, { sourceRunId: payload.sourceRunId, targetRunId, payloadHash: payload.payloadHash, contextEntryId: contextEntryId ?? previous?.contextEntryId, rejected })
      }
    },
    project,
    listUnconsumed(targetRunId: string): ExecutionMailboxMessage[] {
      return database.prepare('SELECT id FROM execution_mailbox_sources WHERE target_run_id = ? ORDER BY created_at, source_run_id, source_sequence').all(targetRunId).flatMap((row) => {
        const record = find(row.id as string)!
        return (record.state === 'pending' || record.state === 'accepted') && !(record.message.kind === 'question' && record.message.audience === 'user') ? [record.message] : []
      })
    },
    listPending(targetRunId: string): ExecutionMailboxMessage[] {
      return database.prepare('SELECT id FROM execution_mailbox_sources WHERE target_run_id = ? ORDER BY created_at, source_run_id, source_sequence').all(targetRunId).flatMap((row) => {
        const record = find(row.id as string)!
        return record.state === 'pending' && !(record.message.kind === 'question' && record.message.audience === 'user') ? [record.message] : []
      })
    },
    resetOwnedFacts(runId: string): void {
      database.prepare('DELETE FROM execution_mailbox_sources WHERE source_run_id = ?').run(runId)
      database.prepare('DELETE FROM execution_mailbox_receipts WHERE target_run_id = ?').run(runId)
    },
  }
}

export type MailboxRepository = ReturnType<typeof createMailboxRepository>
