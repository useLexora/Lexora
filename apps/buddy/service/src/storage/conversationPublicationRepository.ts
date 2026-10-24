import type { DatabaseSync } from 'node:sqlite'
import type { PublicConversationMaterial } from '../conversations/publicConversationContext'
import type { BuddyRunEvent } from '../events/BuddyRunEvent'
import { buddyRunOutputPayloadSchema } from '../../../shared/runs/runOutput'
import { publicConversationMaterialSchema, readPublicMessageReferences, readPublicMessageText } from '../conversations/publicConversationContext'
import { createConversationHistoryStore } from './conversationHistoryRepository'

export function createConversationPublicationRepository(database: DatabaseSync) {
  const history = createConversationHistoryStore(database)
  const rows = database.prepare(`SELECT publications.source_id AS sourceId, publications.sequence,
    publications.branch_id AS branchId, publications.run_id AS runId,
    publications.source_sequence AS sourceSequence, publications.author_actor_id AS actorId,
    publications.kind, publications.message_id AS messageId, messages.role, messages.content_json AS contentJson,
    run_events.payload_json AS outputJson
    FROM conversation_publications publications
    LEFT JOIN messages ON messages.id = publications.message_id
    LEFT JOIN run_events ON run_events.run_id = publications.run_id AND run_events.sequence = publications.source_sequence AND publications.kind = 'output'
    WHERE publications.conversation_id = ? AND publications.sequence <= ? ORDER BY publications.sequence`)

  function getPublicSequence(conversationId: string): number {
    return Number((database.prepare('SELECT sequence FROM conversation_public_heads WHERE conversation_id = ?').get(conversationId) as { sequence: number } | undefined)?.sequence ?? 0)
  }

  return {
    getPublicSequence,
    getMessagePublicSequence(conversationId: string, messageId: string): number {
      const row = database.prepare('SELECT sequence FROM conversation_publications WHERE conversation_id = ? AND message_id = ?').get(conversationId, messageId) as { sequence: number } | undefined
      if (!row)
        throw new Error('Public conversation message is missing')
      return row.sequence
    },
    listPublicBranchIds: (conversationId: string, branchId: string) => history.lineage.listVisibleSegments(conversationId, branchId).map(segment => segment.branchId),
    getPublicSnapshot(runId: string): number {
      const row = database.prepare('SELECT public_sequence AS sequence FROM run_public_snapshots WHERE run_id = ?').get(runId) as { sequence: number } | undefined
      if (!row)
        throw new Error('Execution public snapshot is missing')
      return row.sequence
    },
    getRunPublicBoundary(runId: string, position: 'before' | 'after'): number {
      const row = database.prepare(`SELECT snapshots.public_sequence AS snapshot,
        (SELECT sequence FROM conversation_publications WHERE message_id = runs.triggering_message_id) AS inputSequence,
        (SELECT MAX(sequence) FROM conversation_publications WHERE run_id = runs.id) AS outputSequence
        FROM runs INNER JOIN run_public_snapshots snapshots ON snapshots.run_id = runs.id WHERE runs.id = ?`).get(runId) as { snapshot: number, inputSequence: number | null, outputSequence: number | null } | undefined
      if (!row)
        throw new Error('Execution public snapshot is missing')
      return position === 'before' ? row.inputSequence === null ? row.snapshot : Math.max(0, row.inputSequence - 1) : Math.max(row.snapshot, row.outputSequence ?? 0)
    },
    listPublications(conversationId: string, branchId: string, throughSequence = getPublicSequence(conversationId)): PublicConversationMaterial[] {
      const messages = new Set(history.repository.listBranchMessages(conversationId, branchId).map(message => message.id))
      const segments = new Map(history.lineage.listVisibleSegments(conversationId, branchId).map(segment => [segment.branchId, segment.throughMessage
        ? Number((database.prepare('SELECT sequence FROM conversation_publications WHERE message_id = ?').get(segment.throughMessage.id) as { sequence: number } | undefined)?.sequence ?? 0)
        : throughSequence]))
      return (rows.all(conversationId, throughSequence) as unknown as PublicationRow[]).flatMap((row) => {
        const boundary = segments.get(row.branchId)
        if (boundary === undefined || row.sequence > boundary || (row.kind === 'message' && !messages.has(row.messageId!)))
          return []
        const source = { sourceId: row.sourceId, sequence: row.sequence, branchId: row.branchId, runId: row.runId, sourceSequence: row.sourceSequence, actorId: row.actorId }
        if (row.kind === 'message' && (row.role === 'user' || row.role === 'assistant')) {
          const content = JSON.parse(row.contentJson!)
          const references = row.role === 'user' ? readPublicMessageReferences(content) : []
          return [publicConversationMaterialSchema.parse({ ...source, kind: 'message', messageId: row.messageId, role: row.role, text: readPublicMessageText(content, row.role, row.messageId ?? undefined), ...(references.length ? { references } : {}) })]
        }
        if (!row.outputJson)
          return []
        const output = buddyRunOutputPayloadSchema.safeParse(JSON.parse(row.outputJson))
        if (!output.success)
          return []
        const artifacts = [...new Set(output.data.artifactIds)].flatMap((id) => {
          const artifact = database.prepare('SELECT id AS artifactId, name, kind FROM artifacts WHERE id = ? AND conversation_id = ?')
            .get(id, conversationId)
          return artifact ? [artifact] : []
        })
        return artifacts.length ? [publicConversationMaterialSchema.parse({ ...source, kind: 'output', artifacts })] : []
      })
    },
    reconcilePublicCursor(threadId: string, branchId: string, sequence: number, contextEntryId: string): void {
      database.prepare(`INSERT INTO actor_public_cursors (thread_id, branch_id, public_sequence, context_entry_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(thread_id, branch_id) DO UPDATE SET public_sequence = excluded.public_sequence, context_entry_id = excluded.context_entry_id`)
        .run(threadId, branchId, sequence, contextEntryId)
    },
    findPublicCursor(threadId: string, branchId: string): { sequence: number, contextEntryId: string } | null {
      return database.prepare('SELECT public_sequence AS sequence, context_entry_id AS contextEntryId FROM actor_public_cursors WHERE thread_id = ? AND branch_id = ?')
        .get(threadId, branchId) as { sequence: number, contextEntryId: string } | undefined ?? null
    },
  }
}

export function projectConversationPublication(database: DatabaseSync, event: BuddyRunEvent): void {
  if (event.type === 'message.completed' || event.type === 'message.interrupted') {
    const payload = event.payload as { messageId?: unknown }
    if (typeof payload?.messageId === 'string') {
      database.prepare('UPDATE conversation_publications SET source_sequence = ? WHERE message_id = ? AND run_id = ?')
        .run(event.sequence, payload.messageId, event.runId)
    }
    return
  }
  if (event.type !== 'output.produced')
    return
  if (!buddyRunOutputPayloadSchema.safeParse(event.payload).success)
    return
  database.prepare(`INSERT INTO conversation_publications (source_id, conversation_id, branch_id, sequence, kind, run_id, source_sequence, author_actor_id)
    SELECT ?, runs.conversation_id, runs.branch_id, COALESCE(heads.sequence, 0) + 1, 'output', runs.id, ?, runs.buddy_id
    FROM runs LEFT JOIN conversation_public_heads heads ON heads.conversation_id = runs.conversation_id
    WHERE runs.id = ? AND runs.execution_kind IN ('root', 'actor_child')
    ON CONFLICT(source_id) DO NOTHING`).run(`output:${event.runId}:${event.sequence}`, event.sequence, event.runId)
}

interface PublicationRow {
  sourceId: string
  sequence: number
  branchId: string
  runId: string | null
  sourceSequence: number | null
  actorId: string | null
  kind: 'message' | 'output'
  messageId: string | null
  role: string | null
  contentJson: string | null
  outputJson: string | null
}
