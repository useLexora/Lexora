import type { DatabaseSync } from 'node:sqlite'

export type ChangeCoverage = 'complete' | 'partial'
export type ChangeSetStatus = 'capturing' | 'completed'
export type FileCaptureKind
  = 'binary' | 'missing' | 'oversized' | 'sensitive' | 'text' | 'unavailable'

export interface CapturedFileStateRecord {
  hash: string | null
  kind: FileCaptureKind
  redacted: boolean
  sizeBytes: number | null
  snapshotPath: string | null
}

export interface FileChangeCaptureRecord {
  after: CapturedFileStateRecord | null
  before: CapturedFileStateRecord
  canonicalPath: string | null
  changeSetId: string
  completedAt: string | null
  createdAt: string
  directoryGrantId: string | null
  id: string
  relativePath: string
  status: 'completed' | 'pending'
  toolCallId: string
  toolName: string
  toolReportedError: boolean | null
}

export interface ChangeSetRecord {
  conversationId: string
  coverage: ChangeCoverage
  createdAt: string
  fileCount: number
  id: string
  runId: string
  status: ChangeSetStatus
  updatedAt: string
}

export interface ChangeSetRepository {
  completeCapture: (
    id: string,
    after: CapturedFileStateRecord,
    toolReportedError: boolean,
    completedAt: string,
  ) => boolean
  createCapture: (record: FileChangeCaptureRecord) => void
  ensureSet: (record: ChangeSetRecord) => { created: boolean, record: ChangeSetRecord }
  findCaptureByToolCallId: (toolCallId: string) => FileChangeCaptureRecord | null
  findSetById: (id: string) => ChangeSetRecord | null
  findVisibleSetById: (id: string) => ChangeSetRecord | null
  finalizeSet: (id: string, fileCount: number, updatedAt: string) => boolean
  listCaptures: (changeSetId: string) => FileChangeCaptureRecord[]
  listSetsForRuns: (runIds: readonly string[]) => ChangeSetRecord[]
  markPartial: (id: string, updatedAt: string) => boolean
  updateFileCount: (id: string, fileCount: number, updatedAt: string) => boolean
}

interface ChangeSetRow {
  conversation_id: string
  coverage: ChangeCoverage
  created_at: string
  file_count: number
  id: string
  run_id: string
  status: ChangeSetStatus
  updated_at: string
}

interface FileCaptureRow {
  after_hash: string | null
  after_kind: FileCaptureKind | null
  after_redacted: number | null
  after_size_bytes: number | null
  after_snapshot_path: string | null
  before_hash: string | null
  before_kind: FileCaptureKind
  before_redacted: number
  before_size_bytes: number | null
  before_snapshot_path: string | null
  canonical_path: string | null
  change_set_id: string
  completed_at: string | null
  created_at: string
  directory_grant_id: string | null
  id: string
  relative_path: string
  status: 'completed' | 'pending'
  tool_call_id: string
  tool_name: string
  tool_reported_error: number | null
}

export function createChangeSetRepository(database: DatabaseSync): ChangeSetRepository {
  const findSet = database.prepare('SELECT * FROM run_change_sets WHERE id = ?')
  const findVisibleSet = database.prepare(`
    SELECT run_change_sets.*
    FROM run_change_sets
    INNER JOIN conversations
      ON conversations.id = run_change_sets.conversation_id
    WHERE run_change_sets.id = ? AND conversations.deleted_at IS NULL
  `)
  const ensureSet = database.prepare(`
    INSERT OR IGNORE INTO run_change_sets (
      id, run_id, conversation_id, coverage, status, file_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const findRun = database.prepare(`
    SELECT runs.conversation_id, conversations.deleted_at
    FROM runs
    INNER JOIN conversations ON conversations.id = runs.conversation_id
    WHERE runs.id = ?
  `)
  const insertCapture = database.prepare(`
    INSERT INTO run_file_change_captures (
      id, change_set_id, sequence, tool_call_id, tool_name, relative_path,
      directory_grant_id, canonical_path,
      before_kind, before_size_bytes, before_hash, before_snapshot_path,
      before_redacted,
      after_kind, after_size_bytes, after_hash, after_snapshot_path, after_redacted,
      status, tool_reported_error, created_at, completed_at
    ) VALUES (
      ?, ?,
      (SELECT COALESCE(MAX(sequence), 0) + 1
       FROM run_file_change_captures
       WHERE change_set_id = ?),
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `)
  const findCapture = database.prepare(`
    SELECT * FROM run_file_change_captures
    WHERE tool_call_id = ? AND status = 'pending'
    ORDER BY sequence
    LIMIT 1
  `)
  const completeCapture = database.prepare(`
    UPDATE run_file_change_captures
    SET after_kind = ?, after_size_bytes = ?, after_hash = ?, after_snapshot_path = ?,
        after_redacted = ?, status = 'completed', tool_reported_error = ?, completed_at = ?
    WHERE id = ? AND status = 'pending'
  `)
  const listCaptures = database.prepare(`
    SELECT * FROM run_file_change_captures
    WHERE change_set_id = ?
    ORDER BY sequence
  `)
  const markPartial = database.prepare(`
    UPDATE run_change_sets
    SET coverage = 'partial', updated_at = ?
    WHERE id = ? AND coverage <> 'partial'
  `)
  const updateFileCount = database.prepare(`
    UPDATE run_change_sets SET file_count = ?, updated_at = ? WHERE id = ? AND file_count <> ?
  `)
  const finalizeSet = database.prepare(`
    UPDATE run_change_sets
    SET status = 'completed', file_count = ?, updated_at = ?
    WHERE id = ? AND (status <> 'completed' OR file_count <> ?)
  `)

  return {
    completeCapture(id, after, toolReportedError, completedAt) {
      return Number(completeCapture.run(
        after.kind,
        after.sizeBytes,
        after.hash,
        after.snapshotPath,
        after.redacted ? 1 : 0,
        toolReportedError ? 1 : 0,
        completedAt,
        id,
      ).changes) === 1
    },
    createCapture(record) {
      insertCapture.run(
        record.id,
        record.changeSetId,
        record.changeSetId,
        record.toolCallId,
        record.toolName,
        record.relativePath,
        record.directoryGrantId,
        record.canonicalPath,
        record.before.kind,
        record.before.sizeBytes,
        record.before.hash,
        record.before.snapshotPath,
        record.before.redacted ? 1 : 0,
        record.after?.kind ?? null,
        record.after?.sizeBytes ?? null,
        record.after?.hash ?? null,
        record.after?.snapshotPath ?? null,
        record.after === null ? null : record.after.redacted ? 1 : 0,
        record.status,
        record.toolReportedError === null ? null : record.toolReportedError ? 1 : 0,
        record.createdAt,
        record.completedAt,
      )
    },
    ensureSet(record) {
      const run = findRun.get(record.runId) as {
        conversation_id: string
        deleted_at: string | null
      } | undefined
      if (run?.conversation_id !== record.conversationId || run.deleted_at !== null)
        throw new Error('Lexora Buddy change-set ownership is invalid')
      const result = ensureSet.run(
        record.id,
        record.runId,
        record.conversationId,
        record.coverage,
        record.status,
        record.fileCount,
        record.createdAt,
        record.updatedAt,
      )
      return { created: Number(result.changes) === 1, record: requireChangeSet(findSet.get(record.id), record.id) }
    },
    findCaptureByToolCallId(toolCallId) {
      const row = findCapture.get(toolCallId) as FileCaptureRow | undefined
      return row ? toFileCapture(row) : null
    },
    findSetById(id) {
      const row = findSet.get(id) as ChangeSetRow | undefined
      return row ? toChangeSet(row) : null
    },
    findVisibleSetById(id) {
      const row = findVisibleSet.get(id) as ChangeSetRow | undefined
      return row ? toChangeSet(row) : null
    },
    finalizeSet(id, fileCount, updatedAt) {
      return Number(finalizeSet.run(fileCount, updatedAt, id, fileCount).changes) === 1
    },
    listCaptures(changeSetId) {
      return (listCaptures.all(changeSetId) as unknown as FileCaptureRow[]).map(toFileCapture)
    },
    listSetsForRuns(runIds) {
      if (runIds.length === 0)
        return []
      const rows = database.prepare(`
        SELECT run_change_sets.*
        FROM run_change_sets
        INNER JOIN conversations
          ON conversations.id = run_change_sets.conversation_id
        WHERE run_id IN (${runIds.map(() => '?').join(', ')})
          AND conversations.deleted_at IS NULL
        ORDER BY updated_at, id
      `).all(...runIds) as unknown as ChangeSetRow[]
      return rows.map(toChangeSet)
    },
    markPartial(id, updatedAt) {
      return Number(markPartial.run(updatedAt, id).changes) === 1
    },
    updateFileCount(id, fileCount, updatedAt) {
      return Number(updateFileCount.run(fileCount, updatedAt, id, fileCount).changes) === 1
    },
  }
}

function requireChangeSet(value: unknown, id: string): ChangeSetRecord {
  const row = value as ChangeSetRow | undefined
  if (!row)
    throw new Error(`Lexora Buddy change set was not persisted: ${id}`)
  return toChangeSet(row)
}

function toChangeSet(row: ChangeSetRow): ChangeSetRecord {
  return {
    conversationId: row.conversation_id,
    coverage: row.coverage,
    createdAt: row.created_at,
    fileCount: row.file_count,
    id: row.id,
    runId: row.run_id,
    status: row.status,
    updatedAt: row.updated_at,
  }
}

function toFileCapture(row: FileCaptureRow): FileChangeCaptureRecord {
  return {
    after: row.after_kind
      ? {
          hash: row.after_hash,
          kind: row.after_kind,
          redacted: row.after_redacted === 1,
          sizeBytes: row.after_size_bytes,
          snapshotPath: row.after_snapshot_path,
        }
      : null,
    before: {
      hash: row.before_hash,
      kind: row.before_kind,
      redacted: row.before_redacted === 1,
      sizeBytes: row.before_size_bytes,
      snapshotPath: row.before_snapshot_path,
    },
    changeSetId: row.change_set_id,
    canonicalPath: row.canonical_path,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    directoryGrantId: row.directory_grant_id,
    id: row.id,
    relativePath: row.relative_path,
    status: row.status,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolReportedError: row.tool_reported_error === null
      ? null
      : row.tool_reported_error === 1,
  }
}
