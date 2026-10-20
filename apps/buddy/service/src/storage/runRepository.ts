import type { DatabaseSync } from 'node:sqlite'
import type { ConversationModelSelection } from './conversationRecord'
import type { RunRecord, RunRow, RunStatus } from './runRecord'
import { buddyComposerDraftModelSelectionSchema } from '../../../shared/conversation/composerDraft'
import { withTransaction } from './database'
import { requireRunRecord, toRunRecord } from './runRecord'

export interface CreateRunInput extends Omit<
  RunRecord,
  'rootRunId' | 'parentRunId' | 'executionKind' | 'threadId' | 'generation' | 'buddyId' | 'completedAt' | 'contextWindow' | 'errorCode' | 'executionContext' | 'maxTokens'
> {
  rootRunId?: string
  parentRunId?: string | null
  executionKind?: RunRecord['executionKind']
  threadId?: string
  generation?: number
  buddyId?: string
  completedAt?: string | null
  contextWindow?: number | null
  errorCode?: string | null
  executionContext?: RunRecord['executionContext']
  maxTokens?: number | null
}

export interface RunRepository {
  setModelSelection: (id: string, modelSelection: ConversationModelSelection | null) => boolean
  findActiveForConversation: (conversationId: string) => RunRecord | null
  setActorSnapshot: (id: string, snapshot: NonNullable<RunRecord['actorSnapshot']>) => boolean
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
  findLatestForThread: (threadId: string, branchId: string) => RunRecord | null
  listTree: (rootRunId: string) => RunRecord[]
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
  reconcileQuarantined: (id: string, completedAt: string) => boolean
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
      started_at, completed_at, approval_policy, execution_profile, execution_context_json, buddy_id, actor_snapshot_json, model_override_json, root_run_id, parent_run_id, execution_kind, thread_id, generation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT buddy_id FROM conversations WHERE id = ?)), ?, ?, ?, ?, ?, ?, ?)
  `)
  const list = database.prepare(`
    SELECT * FROM runs
    WHERE conversation_id = ? AND execution_kind IN ('root', 'maintenance')
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
    SELECT * FROM runs WHERE execution_kind IN ('root', 'maintenance') ORDER BY started_at DESC, id DESC LIMIT ?
  `)
  const findLatestForBranch = database.prepare(`
    SELECT * FROM runs
    WHERE conversation_id = ? AND branch_id = ? AND execution_kind IN ('root', 'maintenance') AND pi_session_file IS NOT NULL
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
    setModelSelection(id, modelSelection) {
      const selected = modelSelection === null ? null : buddyComposerDraftModelSelectionSchema.parse(modelSelection)
      return Number(database.prepare('UPDATE runs SET model_override_json = ? WHERE id = ? AND status IN (\'queued\', \'running\')').run(selected ? JSON.stringify(selected) : null, id).changes) === 1
    },
    findActiveForConversation(conversationId) {
      const row = database.prepare('SELECT * FROM runs WHERE conversation_id = ? AND execution_kind IN (\'root\', \'maintenance\') AND status IN (\'queued\', \'running\') ORDER BY started_at DESC, id DESC LIMIT 1').get(conversationId) as RunRow | undefined
      return row ? toRunRecord(row) : null
    },
    setActorSnapshot(id, snapshot) {
      return Number(database.prepare('UPDATE runs SET actor_snapshot_json = ? WHERE id = ? AND status = \'queued\' AND actor_snapshot_json IS NULL').run(JSON.stringify(snapshot), id).changes) === 1
    },
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
        input.buddyId ?? null,
        input.conversationId,
        input.actorSnapshot ? JSON.stringify(input.actorSnapshot) : null,
        input.modelOverride ? JSON.stringify(input.modelOverride) : null,
        input.rootRunId ?? input.id,
        input.parentRunId ?? null,
        input.executionKind ?? (input.purpose === 'conversation.compaction' ? 'maintenance' : 'root'),
        input.threadId ?? null,
        input.generation ?? 0,
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
    findLatestForThread(threadId, branchId) {
      const row = database.prepare('SELECT * FROM runs WHERE thread_id = ? AND branch_id = ? AND pi_session_file IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1').get(threadId, branchId) as unknown as RunRow | undefined
      return row ? toRunRecord(row) : null
    },
    listTree(rootRunId) {
      return (database.prepare('SELECT * FROM runs WHERE root_run_id = ? ORDER BY rowid').all(rootRunId) as unknown as RunRow[]).map(toRunRecord)
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
        WHERE conversation_id = ? AND execution_kind IN ('root', 'maintenance') AND (${clauses.join(' OR ')})
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
    reconcileQuarantined(id, completedAt) {
      return withTransaction(database, () => {
        const run = find.get(id) as RunRow | undefined
        if (!run)
          return false
        database.prepare(`UPDATE execution_state SET cleanup_state = 'degraded', cleanup_error_code = 'EVENT_LOG_CORRUPTED'
          WHERE run_id IN (?, ?)`).run(id, run.root_run_id)
        database.prepare(`UPDATE approvals SET status = 'cancelled', resolved_at = ?
          WHERE run_id = ? AND status = 'pending'`).run(completedAt, id)
        database.prepare('UPDATE runs SET pi_session_file = NULL WHERE id = ?').run(id)
        return Number(database.prepare(`UPDATE runs SET status = 'failed', completed_at = ?, error_code = 'EVENT_LOG_CORRUPTED'
          WHERE id = ? AND status IN ('queued', 'running')`).run(completedAt, id).changes) === 1
      })
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
