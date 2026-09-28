import type { DatabaseSync } from 'node:sqlite'
import type { LocalTaskMark, LocalTaskMarkState, TaskMarkClearInput, TaskMarkInput, TaskMarkReadInput } from '../../../shared/conversation/taskMarkApi'
import { randomUUID } from 'node:crypto'
import { SYSTEM_UNREAD_MARK_ID } from '../../../shared/conversation/taskMarkApi'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { withTransaction } from './database'

interface MarkRow {
  id: string
  name: string
  description: string
  color: string
  created_at: string
  updated_at: string
  task_count: number
}

interface StateRow {
  conversation_id: string
  mark_id: string | null
  result_run_id: string | null
  seen_run_id: string | null
  forced_unread: number
  read_revision: number
}

const STATE_QUERY = `
  SELECT conversations.id AS conversation_id, attention.mark_id, attention.seen_run_id,
    COALESCE(attention.forced_unread, 0) AS forced_unread,
    COALESCE(attention.read_revision, 0) AS read_revision,
    (SELECT runs.id FROM runs
      WHERE runs.conversation_id = conversations.id
        AND runs.status IN ('completed', 'failed') AND runs.purpose <> 'conversation.compaction'
      ORDER BY runs.completed_at DESC, runs.rowid DESC LIMIT 1) AS result_run_id
  FROM conversations
  LEFT JOIN task_attention AS attention ON attention.conversation_id = conversations.id
  WHERE conversations.deleted_at IS NULL
`

export function createTaskMarkRepository(database: DatabaseSync) {
  const listMarks = database.prepare(`
    SELECT task_marks.*, (
      SELECT COUNT(*) FROM task_attention
      INNER JOIN conversations ON conversations.id = task_attention.conversation_id
      WHERE task_attention.mark_id = task_marks.id AND conversations.deleted_at IS NULL
    ) AS task_count
    FROM task_marks ORDER BY created_at, id
  `)
  const readState = database.prepare(`${STATE_QUERY} AND conversations.id = ?`)
  const insert = database.prepare('INSERT INTO task_marks (id, name, description, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  const update = database.prepare('UPDATE task_marks SET name = ?, description = ?, color = ?, updated_at = ? WHERE id = ?')
  const remove = database.prepare('DELETE FROM task_marks WHERE id = ?')
  const assign = database.prepare(`
    INSERT INTO task_attention (conversation_id, mark_id) VALUES (?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET mark_id = excluded.mark_id
  `)
  const setRead = database.prepare(`
    INSERT INTO task_attention (conversation_id, seen_run_id, forced_unread, read_revision) VALUES (?, ?, ?, 1)
    ON CONFLICT(conversation_id) DO UPDATE SET
      seen_run_id = excluded.seen_run_id, forced_unread = excluded.forced_unread,
      read_revision = task_attention.read_revision + 1
  `)

  function list(): LocalTaskMark[] {
    return (listMarks.all() as unknown as MarkRow[]).map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      color: row.color,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      taskCount: row.task_count,
    }))
  }

  function requireMark(id: string): LocalTaskMark {
    if (id === SYSTEM_UNREAD_MARK_ID)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const mark = list().find(mark => mark.id === id)
    if (!mark)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return mark
  }

  function getState(conversationId: string): LocalTaskMarkState {
    const row = readState.get(conversationId) as StateRow | undefined
    if (!row)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return toState(row)
  }

  function deleteWithReceipt(id: string) {
    return withTransaction(database, () => {
      requireMark(id)
      const affected = database.prepare('SELECT conversation_id FROM task_attention WHERE mark_id = ?').all(id) as { conversation_id: string }[]
      const deleted = Number(remove.run(id).changes) === 1
      return { deleted, conversationIds: affected.map(row => row.conversation_id) }
    })
  }

  return {
    list,
    getState,
    allStates(): LocalTaskMarkState[] {
      return (database.prepare(STATE_QUERY).all() as unknown as StateRow[]).map(toState)
    },
    states(conversationIds: readonly string[]): LocalTaskMarkState[] {
      if (conversationIds.length === 0)
        return []
      return (database.prepare(`${STATE_QUERY} AND conversations.id IN (${conversationIds.map(() => '?').join(', ')})`)
        .all(...conversationIds) as unknown as StateRow[]).map(toState)
    },
    create(input: TaskMarkInput): LocalTaskMark {
      const id = randomUUID()
      const now = new Date().toISOString()
      insert.run(id, input.name, input.description, input.color, now, now)
      return requireMark(id)
    },
    update(id: string, input: TaskMarkInput): LocalTaskMark {
      requireMark(id)
      update.run(input.name, input.description, input.color, new Date().toISOString(), id)
      return requireMark(id)
    },
    delete(id: string): boolean {
      return deleteWithReceipt(id).deleted
    },
    deleteWithReceipt,
    assign(conversationId: string, markId: string | null): LocalTaskMarkState {
      return withTransaction(database, () => {
        getState(conversationId)
        if (markId !== null)
          requireMark(markId)
        assign.run(conversationId, markId)
        return getState(conversationId)
      })
    },
    clear(input: TaskMarkClearInput): LocalTaskMarkState {
      return withTransaction(database, () => {
        const state = getState(input.conversationId)
        assign.run(input.conversationId, null)
        if (state.resultRunId === input.resultRunId && state.readRevision === input.readRevision)
          setRead.run(input.conversationId, state.resultRunId, 0)
        return getState(input.conversationId)
      })
    },
    setRead(input: TaskMarkReadInput): LocalTaskMarkState {
      return withTransaction(database, () => {
        const state = getState(input.conversationId)
        if (input.read && (state.resultRunId !== input.resultRunId || state.readRevision !== input.readRevision))
          return state
        setRead.run(input.conversationId, input.read ? state.resultRunId : null, input.read ? 0 : 1)
        return getState(input.conversationId)
      })
    },
  }
}

function toState(row: StateRow): LocalTaskMarkState {
  return {
    conversationId: row.conversation_id,
    markId: row.mark_id,
    resultRunId: row.result_run_id,
    readRevision: row.read_revision,
    unread: row.forced_unread === 1 || (row.result_run_id !== null && row.result_run_id !== row.seen_run_id),
  }
}

export type TaskMarkRepository = ReturnType<typeof createTaskMarkRepository>
