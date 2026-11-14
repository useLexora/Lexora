import type { DatabaseSync } from 'node:sqlite'
import type { ConversationModelSelection } from './conversationRecord'
import { canonicalCommandJson } from '../commands/commandIntent'
import { ChatControlConflictError } from './ChatControlCommandRepository'
import { createRunInputRepository } from './runInputRepository'
import { createRunRepository } from './runRepository'
import { requireSqliteAuthority } from './sqliteAuthority'
import { createTaskMarkRepository } from './taskMarkRepository'

export class ConversationCommandRepository {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    requireSqliteAuthority(database)
    this.#database = database
  }

  conversationRevision(conversationId: string, title = false): number {
    const row = this.#database.prepare('SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL').get(conversationId)
    if (!row)
      throw new ChatControlConflictError('OBJECT_DELETED')
    if (row.archived_at)
      throw new ChatControlConflictError('SOURCE_CHANGED')
    return Number(title ? row.title_revision : row.metadata_revision)
  }

  assertConversation(conversationId: string, expectedRevision: number, title = false): void {
    if (this.conversationRevision(conversationId, title) !== expectedRevision)
      throw new ChatControlConflictError('SOURCE_CHANGED')
  }

  assertRunModel(input: { conversationId: string, actorId?: string, targetRunId: string, expectedRunGeneration: number, expectedRunModelSelection: ConversationModelSelection | null }): void {
    const run = createRunRepository(this.#database).findById(input.targetRunId)
    if (!run || run.conversationId !== input.conversationId || (input.actorId && run.buddyId !== input.actorId)
      || run.generation !== input.expectedRunGeneration || !['queued', 'running'].includes(run.status)
      || this.#database.prepare('SELECT cancel_requested_at FROM execution_state WHERE run_id = ?').get(run.id)?.cancel_requested_at) {
      throw new ChatControlConflictError('SOURCE_CHANGED')
    }
    const stored = createRunInputRepository(this.#database).findByRunId(run.id)
    const selection = run.modelOverride ?? run.actorSnapshot?.model ?? { providerId: run.provider, modelId: run.model, reasoning: stored?.reasoning ?? null, serviceTier: stored?.serviceTier ?? null }
    if (canonicalCommandJson(selection) !== canonicalCommandJson(input.expectedRunModelSelection))
      throw new ChatControlConflictError('SOURCE_CHANGED')
  }

  assertActiveRunModel(input: { conversationId: string, actorId: string, expectedActiveRun: { runId: string, generation: number, modelSelection: ConversationModelSelection } | null }): void {
    const run = createRunRepository(this.#database).findActiveForConversation(input.conversationId, input.actorId)
    if ((run?.id ?? null) !== (input.expectedActiveRun?.runId ?? null))
      throw new ChatControlConflictError('SOURCE_CHANGED')
    if (input.expectedActiveRun) {
      this.assertRunModel({
        conversationId: input.conversationId,
        actorId: input.actorId,
        targetRunId: input.expectedActiveRun.runId,
        expectedRunGeneration: input.expectedActiveRun.generation,
        expectedRunModelSelection: input.expectedActiveRun.modelSelection,
      })
    }
  }

  markRevision(markId: string): number {
    const row = this.#database.prepare('SELECT revision FROM task_marks WHERE id = ?').get(markId)
    if (!row)
      throw new ChatControlConflictError('OBJECT_DELETED')
    return Number(row.revision)
  }

  assertMark(markId: string, expectedRevision: number): void {
    if (this.markRevision(markId) !== expectedRevision)
      throw new ChatControlConflictError('SOURCE_CHANGED')
  }

  assignmentRevision(conversationId: string): number {
    this.conversationRevision(conversationId)
    return Number(this.#database.prepare('SELECT assignment_revision FROM task_attention WHERE conversation_id = ?').get(conversationId)?.assignment_revision ?? 0)
  }

  assertAssignment(conversationId: string, expectedRevision: number): void {
    if (this.assignmentRevision(conversationId) !== expectedRevision)
      throw new ChatControlConflictError('SOURCE_CHANGED')
  }

  assertRead(input: { conversationId: string, readRevision: number, resultRunId: string | null }): void {
    this.conversationRevision(input.conversationId)
    const current = createTaskMarkRepository(this.#database).getState(input.conversationId)
    if (current.readRevision !== input.readRevision || current.resultRunId !== input.resultRunId)
      throw new ChatControlConflictError('SOURCE_CHANGED')
  }
}
