import type { DatabaseSync } from 'node:sqlite'
import type { RunRecord, RunRow, RunStatus } from './runRecord'
import { withTransaction } from './database'
import { requireRunRecord, toRunRecord } from './runRecord'

export interface CreateRunInput extends Omit<
  RunRecord,
  'completedAt' | 'contextWindow' | 'errorCode' | 'executionContext' | 'maxTokens'
> {
  completedAt?: string | null
  contextWindow?: number | null
  errorCode?: string | null
  executionContext?: RunRecord['executionContext']
  maxTokens?: number | null
}

export interface RunRepository {
  bindSession: (id: string, piSessionFile: string) => boolean
  clearSessionBindings: (
    conversationId: string,
    branchId: string,
    piSessionFile: string,
  ) => number
  clearSessionBindingsWithReceipt: (conversationId: string, branchId: string, piSessionFile: string) => string[]
  create: (input: CreateRunInput) => RunRecord
  findById: (id: string) => RunRecord | null
  findLatestForBranch: (conversationId: string, branchId: string) => RunRecord | null
  hasIncomplete: () => boolean
  listIncomplete: () => RunRecord[]
  listRecent: (limit?: number) => RunRecord[]
  listForConversation: (conversationId: string, limit?: number) => RunRecord[]
  listForTimeline: (
    conversationId: string,
    activeBranchId: string,
    triggeringMessageIds: readonly string[],
    runIds: readonly string[],
  ) => RunRecord[]
  listIdsForConversation: (conversationId: string) => string[]
  markRunning: (id: string, startedAt: string) => boolean
  reconcileTerminal: (
    id: string,
    status: Extract<RunStatus, 'cancelled' | 'completed' | 'failed'>,
    completedAt: string,
    errorCode: string | null,
  ) => boolean
}

export function createRunRepository(database: DatabaseSync): RunRepository {
  const find = database.prepare('SELECT * FROM runs WHERE id = ?')
  const insert = database.prepare(`
    INSERT INTO runs (
      id, conversation_id, branch_id, triggering_message_id, provider, model,
      context_window, max_tokens, purpose, status, pi_session_file, error_code,
      started_at, completed_at, approval_policy, execution_profile, execution_context_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const list = database.prepare(`
    SELECT * FROM runs
    WHERE conversation_id = ?
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `)
  const listIds = database.prepare(`
    SELECT id FROM runs WHERE conversation_id = ? ORDER BY started_at, id
  `)
  const listIncomplete = database.prepare(`
    SELECT * FROM runs WHERE status IN ('queued', 'running') ORDER BY started_at, id
  `)
  const listRecent = database.prepare(`
    SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT ?
  `)
  const findLatestForBranch = database.prepare(`
    SELECT * FROM runs
    WHERE conversation_id = ? AND branch_id = ? AND pi_session_file IS NOT NULL
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `)
  const markRunning = database.prepare(`
    UPDATE runs
    SET status = 'running', started_at = ?, completed_at = NULL, error_code = NULL
    WHERE id = ? AND status = 'queued'
      AND EXISTS (SELECT 1 FROM conversations WHERE conversations.id = runs.conversation_id AND deleted_at IS NULL)
  `)
  const reconcileTerminal = database.prepare(`
    UPDATE runs SET status = ?, completed_at = ?, error_code = ?
    WHERE id = ? AND status IN ('queued', 'running', ?)
  `)
  const bindSession = database.prepare(`
    UPDATE runs SET pi_session_file = ? WHERE id = ?
  `)
  const clearSessionBindings = database.prepare(`
    UPDATE runs SET pi_session_file = NULL
    WHERE conversation_id = ? AND branch_id = ? AND pi_session_file = ?
  `)
  const clearBindings = (conversationId: string, branchId: string, piSessionFile: string): string[] => withTransaction(database, () => {
    const affected = database.prepare('SELECT id FROM runs WHERE conversation_id = ? AND branch_id = ? AND pi_session_file = ?').all(conversationId, branchId, piSessionFile) as { id: string }[]
    clearSessionBindings.run(conversationId, branchId, piSessionFile)
    return affected.map(run => run.id)
  })

  return {
    bindSession(id, piSessionFile) {
      return Number(bindSession.run(piSessionFile, id).changes) === 1
    },
    clearSessionBindings(conversationId, branchId, piSessionFile) {
      return clearBindings(conversationId, branchId, piSessionFile).length
    },
    clearSessionBindingsWithReceipt: clearBindings,
    create(input) {
      insert.run(
        input.id,
        input.conversationId,
        input.branchId,
        input.triggeringMessageId,
        input.provider,
        input.model,
        input.contextWindow ?? null,
        input.maxTokens ?? null,
        input.purpose,
        input.status,
        input.piSessionFile,
        input.errorCode ?? null,
        input.startedAt,
        input.completedAt ?? null,
        input.approvalPolicy,
        input.executionProfile,
        input.executionContext ? JSON.stringify(input.executionContext) : null,
      )
      return requireRunRecord(find.get(input.id), input.id)
    },
    findById(id) {
      const row = find.get(id) as RunRow | undefined
      return row ? toRunRecord(row) : null
    },
    findLatestForBranch(conversationId, branchId) {
      const row = findLatestForBranch.get(conversationId, branchId) as RunRow | undefined
      return row ? toRunRecord(row) : null
    },
    listForConversation(conversationId, limit = 100) {
      return (list.all(conversationId, limit) as unknown as RunRow[]).map(toRunRecord)
    },
    listForTimeline(conversationId, activeBranchId, triggeringMessageIds, runIds) {
      const clauses: string[] = []
      const parameters: Array<string> = [conversationId]
      if (runIds.length > 0) {
        clauses.push(`id IN (${runIds.map(() => '?').join(', ')})`)
        parameters.push(...runIds)
      }
      if (triggeringMessageIds.length > 0) {
        clauses.push(`(
          branch_id = ?
          AND triggering_message_id IN (${triggeringMessageIds.map(() => '?').join(', ')})
        )`)
        parameters.push(activeBranchId, ...triggeringMessageIds)
      }
      if (clauses.length === 0)
        return []
      const rows = database.prepare(`
        SELECT * FROM runs
        WHERE conversation_id = ? AND (${clauses.join(' OR ')})
        ORDER BY started_at, id
      `).all(...parameters) as unknown as RunRow[]
      return rows.map(toRunRecord)
    },
    listIdsForConversation(conversationId) {
      return (listIds.all(conversationId) as unknown as Array<{ id: string }>).map(row => row.id)
    },
    hasIncomplete() {
      return !!database.prepare('SELECT 1 FROM runs WHERE status IN (\'queued\', \'running\') LIMIT 1').get()
    },
    listIncomplete() {
      return (listIncomplete.all() as unknown as RunRow[]).map(toRunRecord)
    },
    listRecent(limit = 100) {
      return (listRecent.all(limit) as unknown as RunRow[]).map(toRunRecord)
    },
    markRunning(id, startedAt) {
      return Number(markRunning.run(startedAt, id).changes) === 1
    },
    reconcileTerminal(id, status, completedAt, errorCode) {
      return Number(reconcileTerminal.run(
        status,
        completedAt,
        errorCode,
        id,
        status,
      ).changes) === 1
    },
  }
}
