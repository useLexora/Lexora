import type { DatabaseSync } from 'node:sqlite'
import type { z } from 'zod'
import type { MessageRecord } from '../storage/conversationHistoryRepository'
import type { ConversationRecord, ConversationRow } from '../storage/conversationRecord'
import { productTaskSchema, productTaskSummarySchema } from '../../../shared/productProtocol/queries'
import { encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { CONVERSATION_CURRENT_MODEL_SELECTION_SQL, toConversationRecord } from '../storage/conversationRecord'
import { createTaskMarkRepository } from '../storage/taskMarkRepository'

type PreviewMessage = Pick<MessageRecord, 'role' | 'content'>
type TaskSummary = z.infer<typeof productTaskSummarySchema>

export class ProductTaskReadModel {
  readonly #database: DatabaseSync
  readonly #marks: ReturnType<typeof createTaskMarkRepository>
  readonly #preview: (message: PreviewMessage) => string

  constructor(database: DatabaseSync, preview: (message: PreviewMessage) => string) {
    this.#database = database
    this.#marks = createTaskMarkRepository(database)
    this.#preview = preview
  }

  get(id: string) {
    const row = this.#database.prepare(`SELECT conversations.*, ${CONVERSATION_CURRENT_MODEL_SELECTION_SQL} AS actor_model_selection_json FROM conversations WHERE id = ? AND deleted_at IS NULL`).get(id) as ConversationRow | undefined
    return row ? this.#project(toConversationRecord(row)) : null
  }

  summaries(ids: readonly string[]): ReadonlyMap<string, TaskSummary> {
    if (!ids.length)
      return new Map()
    const selected = JSON.stringify([...new Set(ids)])
    const tasks = this.#database.prepare(`SELECT conversations.*, ${CONVERSATION_CURRENT_MODEL_SELECTION_SQL} AS actor_model_selection_json FROM conversations
      WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND archived_at IS NULL`).all(selected) as unknown as ConversationRow[]
    const states = new Map(this.#marks.states(tasks.map(task => task.id)).map(state => [state.conversationId, state]))
    const facts = new Map(this.#database.prepare(`SELECT c.id,
      CASE WHEN EXISTS (SELECT 1 FROM approvals a JOIN runs r ON r.id = a.run_id WHERE r.conversation_id = c.id AND a.status = 'pending') THEN 'awaiting_approval'
        WHEN EXISTS (SELECT 1 FROM runs WHERE conversation_id = c.id AND status IN ('queued', 'running')) THEN 'running' ELSE 'idle' END AS activity,
      (SELECT COUNT(*) FROM user_questions q JOIN runs r ON r.id = q.run_id WHERE r.conversation_id = c.id AND json_extract(q.request_json, '$.status') = 'pending') AS pending_question_count,
      last_run.status AS last_run_status, occurrence.automation_id, occurrence.id AS occurrence_id, occurrence.scheduled_for
      FROM conversations c
      LEFT JOIN runs last_run ON last_run.id = (SELECT id FROM runs WHERE conversation_id = c.id AND execution_kind = 'root' AND purpose <> 'conversation.compaction' ORDER BY COALESCE(completed_at, started_at) DESC, rowid DESC LIMIT 1)
      LEFT JOIN automation_occurrences occurrence ON occurrence.id = (SELECT id FROM automation_occurrences WHERE conversation_id = c.id AND deleted_at IS NULL ORDER BY scheduled_for DESC, id DESC LIMIT 1)
      WHERE c.id IN (SELECT value FROM json_each(?)) AND c.deleted_at IS NULL AND c.archived_at IS NULL`).all(selected).map(row => [String(row.id), row]))
    const resultIds = [...states.values()].flatMap(state => state.resultRunId ? [state.resultRunId] : [])
    const results = new Map(this.#database.prepare('SELECT id, conversation_id, branch_id FROM runs WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(resultIds)).map(row => [String(row.id), row]))
    const previews = this.#database.prepare(`SELECT c.id, (
      SELECT json_group_array(json_object('branchId', message.branch_id, 'role', message.role, 'content', json(message.content_json)))
      FROM (
        SELECT m.branch_id, m.role, m.content_json FROM conversation_publications p JOIN messages m ON m.id = p.message_id
        LEFT JOIN runs r ON r.id = m.run_id WHERE p.conversation_id = c.id AND p.kind = 'message' AND m.role IN ('user', 'assistant')
          AND (m.run_id IS NULL OR r.execution_kind IN ('root', 'actor_child')) ORDER BY p.sequence DESC LIMIT 20
      ) message
    ) AS messages FROM conversations c WHERE c.id IN (SELECT value FROM json_each(?)) AND c.deleted_at IS NULL AND c.archived_at IS NULL`).all(selected)
    const text = new Map<string, { previewText: string, previewBranchId: string }>()
    for (const row of previews) {
      const messages = JSON.parse(String(row.messages)) as Array<PreviewMessage & { branchId: string }>
      for (const message of messages) {
        const previewText = this.#preview(message)
        if (previewText) {
          text.set(String(row.id), { previewText, previewBranchId: message.branchId })
          break
        }
      }
    }
    return new Map(tasks.map((task) => {
      const state = states.get(task.id)!
      const fact = facts.get(task.id)!
      const result = state.resultRunId ? results.get(state.resultRunId) : undefined
      return [task.id, productTaskSummarySchema.parse({
        ...this.#project(toConversationRecord(task)),
        activity: fact.activity,
        unread: state.unread,
        previewText: '',
        ...text.get(task.id),
        ...(result?.conversation_id === task.id ? { resultBranchId: result.branch_id, resultRunId: result.id } : {}),
        lastRunStatus: fact.last_run_status ?? null,
        pendingQuestionCount: Number(fact.pending_question_count),
        automationOccurrence: fact.occurrence_id ? { automationId: fact.automation_id, occurrenceId: fact.occurrence_id, scheduledFor: fact.scheduled_for } : null,
      })]
    }))
  }

  #project(task: ConversationRecord) {
    const fields = Object.fromEntries(Object.keys(productTaskSchema.shape).filter(key => key in task).map(key => [key, task[key as keyof typeof task]]))
    return productTaskSchema.parse({ ...fields, revision: encodeProductRevision(task.metadataRevision!), titleRevision: encodeProductRevision(task.titleRevision!) })
  }
}
