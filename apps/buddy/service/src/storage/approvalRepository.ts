import type { DatabaseSync } from 'node:sqlite'

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'cancelled'

export interface ApprovalRecord {
  id: string
  runId: string
  toolCallId: string
  kind: string
  status: ApprovalStatus
  summary: string
  payload: unknown
  createdAt: string
  resolvedAt: string | null
}

export interface ApprovalRepository {
  hasPending: (runId: string) => boolean
  findById: (id: string) => ApprovalRecord | null
  list: (options?: { limit?: number, runId?: string | null, status?: ApprovalStatus | null, conversationId?: string, branchId?: string }) => ApprovalRecord[]
  listPending: (runId?: string) => ApprovalRecord[]
}

interface ApprovalRow {
  id: string
  run_id: string
  tool_call_id: string
  kind: string
  status: ApprovalStatus
  summary: string
  payload_json: string
  created_at: string
  resolved_at: string | null
}

export function createApprovalRepository(database: DatabaseSync): ApprovalRepository {
  const pending = database.prepare('SELECT 1 FROM approvals WHERE run_id = ? AND status = \'pending\' LIMIT 1')
  const find = database.prepare('SELECT * FROM approvals WHERE id = ?')
  const listAllPending = database.prepare(`
    SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at, id
  `)
  const listRunPending = database.prepare(`
    SELECT * FROM approvals
    WHERE status = 'pending' AND run_id = ?
    ORDER BY created_at, id
  `)
  const listByFilters = database.prepare(`
    SELECT a.* FROM approvals a
    WHERE (? IS NULL OR a.run_id = ?) AND (? IS NULL OR a.status = ?)
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM runs r
        JOIN runs root ON root.id = r.root_run_id
        JOIN conversations c ON c.id = root.conversation_id
        WHERE r.id = a.run_id AND root.execution_kind = 'root'
          AND root.conversation_id = ? AND root.branch_id = ?
          AND r.conversation_id = root.conversation_id AND r.branch_id = root.branch_id
          AND c.deleted_at IS NULL
      ))
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ?
  `)

  return {
    hasPending: runId => pending.get(runId) !== undefined,
    findById(id) {
      const row = find.get(id) as ApprovalRow | undefined
      return row ? toApproval(row) : null
    },
    listPending(runId) {
      const rows = runId ? listRunPending.all(runId) : listAllPending.all()
      return (rows as unknown as ApprovalRow[]).map(toApproval)
    },
    list(options = {}) {
      const runId = options.runId ?? null
      const status = options.status ?? null
      return (listByFilters.all(
        runId,
        runId,
        status,
        status,
        options.conversationId ?? null,
        options.conversationId ?? null,
        options.branchId ?? null,
        options.limit ?? 100,
      ) as unknown as ApprovalRow[]).map(toApproval)
    },
  }
}

function toApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}
