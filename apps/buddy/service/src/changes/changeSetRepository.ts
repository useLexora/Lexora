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
  invocation?: ChangeInvocationRecord | null
  invocationId?: string | null
  actorId?: string | null
  actorName?: string | null
  relativePath: string
  status: 'completed' | 'pending'
  toolCallId: string
  toolName: string
  toolReportedError: boolean | null
}

export interface ChangeInvocationRecord {
  id: string
  runId: string
  segmentId: string
  sequence: number
  toolCallId: string
  toolName: string
  status: 'pending' | 'completed' | 'partial'
  createdAt: string
  completedAt: string | null
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

export interface ChangeTreeSetRecord extends ChangeSetRecord {
  rootRunId: string
}

export interface ChangeSetRepository {
  findVisibleRun: (runId: string) => { id: string, conversationId: string, rootRunId: string, status: string } | null
  listSetsForRunTrees: (runIds: readonly string[]) => ChangeTreeSetRecord[]
  createInvocation: (record: Omit<ChangeInvocationRecord, 'sequence'>) => ChangeInvocationRecord
  findInvocation: (id: string) => ChangeInvocationRecord | null
  completeInvocation: (id: string, status: 'completed' | 'partial', completedAt: string) => boolean
  interruptInvocations: (runId: string, completedAt: string) => number
  completeCapture: (
    id: string,
    after: CapturedFileStateRecord,
    toolReportedError: boolean,
    completedAt: string,
  ) => boolean
  createCapture: (record: FileChangeCaptureRecord) => void
  ensureSet: (record: ChangeSetRecord) => { created: boolean, record: ChangeSetRecord }
  findCaptureById: (id: string) => FileChangeCaptureRecord | null
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
  invocation_id: string | null
  actor_id: string | null
  actor_name: string | null
  invocation_sequence: number | null
  invocation_run_id: string | null
  invocation_segment_id: string | null
  invocation_status: ChangeInvocationRecord['status'] | null
  invocation_created_at: string | null
  invocation_completed_at: string | null
  relative_path: string
  status: 'completed' | 'pending'
  tool_call_id: string
  tool_name: string
  tool_reported_error: number | null
}

interface ChangeInvocationRow {
  id: string
  run_id: string
  segment_id: string
  sequence: number
  tool_call_id: string
  tool_name: string
  status: ChangeInvocationRecord['status']
  created_at: string
  completed_at: string | null
}

const CAPTURE_SELECT = `
  SELECT captures.*, invocations.sequence AS invocation_sequence,
    invocations.run_id AS invocation_run_id, invocations.segment_id AS invocation_segment_id,
    invocations.status AS invocation_status, invocations.created_at AS invocation_created_at,
    invocations.completed_at AS invocation_completed_at, runs.buddy_id AS actor_id, buddies.name AS actor_name
  FROM run_file_change_captures AS captures
  LEFT JOIN run_change_invocations AS invocations ON invocations.id = captures.invocation_id
  LEFT JOIN runs ON runs.id = invocations.run_id
  LEFT JOIN buddies ON buddies.id = runs.buddy_id
`

export function createChangeSetRepository(database: DatabaseSync): ChangeSetRepository {
  const insertInvocation = database.prepare(`
    INSERT INTO run_change_invocations (id, run_id, segment_id, tool_call_id, tool_name, status, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const findInvocation = database.prepare('SELECT * FROM run_change_invocations WHERE id = ?')
  const completeInvocation = database.prepare('UPDATE run_change_invocations SET status = ?, completed_at = ? WHERE id = ? AND status = \'pending\'')
  const interruptInvocations = database.prepare('UPDATE run_change_invocations SET status = \'partial\', completed_at = ? WHERE run_id = ? AND status = \'pending\'')
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
      directory_grant_id, canonical_path, invocation_id,
      before_kind, before_size_bytes, before_hash, before_snapshot_path,
      before_redacted,
      after_kind, after_size_bytes, after_hash, after_snapshot_path, after_redacted,
      status, tool_reported_error, created_at, completed_at
    ) VALUES (
      ?, ?,
      (SELECT COALESCE(MAX(sequence), 0) + 1
       FROM run_file_change_captures
       WHERE change_set_id = ?),
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `)
  const findCaptureById = database.prepare(`${CAPTURE_SELECT} WHERE captures.id = ?`)
  const completeCapture = database.prepare(`
    UPDATE run_file_change_captures
    SET after_kind = ?, after_size_bytes = ?, after_hash = ?, after_snapshot_path = ?,
        after_redacted = ?, status = 'completed', tool_reported_error = ?, completed_at = ?
    WHERE id = ? AND status = 'pending'
  `)
  const listCaptures = database.prepare(`${CAPTURE_SELECT}
    WHERE captures.change_set_id = ?
    ORDER BY captures.sequence
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
    findVisibleRun(runId) {
      const row = database.prepare(`SELECT runs.id, runs.conversation_id, runs.root_run_id, runs.status FROM runs INNER JOIN conversations ON conversations.id = runs.conversation_id WHERE runs.id = ? AND conversations.deleted_at IS NULL`).get(runId) as { id: string, conversation_id: string, root_run_id: string, status: string } | undefined
      return row ? { id: row.id, conversationId: row.conversation_id, rootRunId: row.root_run_id, status: row.status } : null
    },
    listSetsForRunTrees(runIds) {
      if (!runIds.length)
        return []
      const slots = runIds.map(() => '?').join(', ')
      const rows = database.prepare(`
        SELECT run_change_sets.*, runs.root_run_id FROM run_change_sets
        INNER JOIN runs ON runs.id = run_change_sets.run_id
        INNER JOIN conversations ON conversations.id = runs.conversation_id
        WHERE (runs.id IN (${slots}) OR runs.root_run_id IN (${slots})) AND conversations.deleted_at IS NULL
        ORDER BY run_change_sets.updated_at, run_change_sets.id
      `).all(...runIds, ...runIds) as unknown as (ChangeSetRow & { root_run_id: string })[]
      return rows.map(row => ({ ...toChangeSet(row), rootRunId: row.root_run_id }))
    },
    createInvocation(record) {
      insertInvocation.run(record.id, record.runId, record.segmentId, record.toolCallId, record.toolName, record.status, record.createdAt, record.completedAt)
      return toInvocation(findInvocation.get(record.id) as unknown as ChangeInvocationRow)
    },
    findInvocation(id) {
      const row = findInvocation.get(id) as unknown as ChangeInvocationRow | undefined
      return row ? toInvocation(row) : null
    },
    completeInvocation(id, status, completedAt) {
      return Number(completeInvocation.run(status, completedAt, id).changes) === 1
    },
    interruptInvocations(runId, completedAt) {
      return Number(interruptInvocations.run(completedAt, runId).changes)
    },
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
        record.invocationId ?? null,
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
    findCaptureById(id) {
      const row = findCaptureById.get(id) as FileCaptureRow | undefined
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
    invocationId: row.invocation_id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    invocation: row.invocation_id && row.invocation_sequence !== null
      ? {
          id: row.invocation_id,
          runId: row.invocation_run_id!,
          segmentId: row.invocation_segment_id!,
          sequence: row.invocation_sequence,
          toolCallId: row.tool_call_id,
          toolName: row.tool_name,
          status: row.invocation_status!,
          createdAt: row.invocation_created_at!,
          completedAt: row.invocation_completed_at,
        }
      : null,
    relativePath: row.relative_path,
    status: row.status,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolReportedError: row.tool_reported_error === null
      ? null
      : row.tool_reported_error === 1,
  }
}

function toInvocation(row: ChangeInvocationRow): ChangeInvocationRecord {
  return {
    id: row.id,
    runId: row.run_id,
    segmentId: row.segment_id,
    sequence: row.sequence,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}
