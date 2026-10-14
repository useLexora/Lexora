import type { DatabaseSync } from 'node:sqlite'
import { buddySessionReferencesSchema } from '../../../shared/conversation/buddyUserContent'
import { createConversationHistoryStore } from './conversationHistoryRepository'

export interface SessionReferenceScope {
  conversationId: string
  branchId: string
  throughSequence: number
}

export function createSessionReferenceRepository(database: DatabaseSync) {
  const { lineage } = createConversationHistoryStore(database)
  return {
    findRunScope(runId: string): SessionReferenceScope | null {
      return database.prepare(`SELECT runs.conversation_id AS conversationId, runs.branch_id AS branchId,
        scopes.public_sequence AS throughSequence FROM run_session_reference_scopes scopes JOIN runs ON runs.id = scopes.run_id
        WHERE runs.id = ?`).get(runId) as SessionReferenceScope | undefined ?? null
    },
    readGraph(runId: string, throughSequence: number): unknown | null {
      const row = database.prepare('SELECT graph_json AS graph FROM run_session_reference_scopes WHERE run_id = ? AND public_sequence = ?')
        .get(runId, throughSequence) as { graph: string | null } | undefined
      return row?.graph ? JSON.parse(row.graph) : null
    },
    saveGraph(runId: string, throughSequence: number, graph: unknown): void {
      database.prepare('UPDATE run_session_reference_scopes SET graph_json = ? WHERE run_id = ? AND public_sequence = ? AND graph_json IS NULL')
        .run(JSON.stringify(graph), runId, throughSequence)
    },
    messageSequence(conversationId: string, messageId: string): number | null {
      const row = database.prepare('SELECT sequence FROM conversation_publications WHERE conversation_id = ? AND message_id = ?')
        .get(conversationId, messageId) as { sequence: number } | undefined
      return row?.sequence ?? null
    },
    headSequence(conversationId: string): number {
      return Number((database.prepare('SELECT sequence FROM conversation_public_heads WHERE conversation_id = ?').get(conversationId) as { sequence: number } | undefined)?.sequence ?? 0)
    },
    listReferences(scope: SessionReferenceScope, limit: number) {
      const segments = lineage.listVisibleSegments(scope.conversationId, scope.branchId).toReversed()
      const items: { messageId: string, references: ReturnType<typeof buddySessionReferencesSchema.parse> }[] = []
      for (const segment of segments) {
        const boundary = segment.throughMessage
        const rows = database.prepare(`SELECT messages.id AS messageId,
          json_extract(messages.content_json, '$.userContent.sessionReferences') AS referencesJson
          FROM messages JOIN conversation_publications publications ON publications.message_id = messages.id
          WHERE messages.conversation_id = ? AND messages.branch_id = ? AND messages.role = 'user'
          AND publications.sequence <= ? AND json_array_length(messages.content_json, '$.userContent.sessionReferences') > 0
          ${boundary ? 'AND (messages.created_at < ? OR (messages.created_at = ? AND messages.id <= ?))' : ''}
          ORDER BY publications.sequence DESC LIMIT ?`).all(scope.conversationId, segment.branchId, scope.throughSequence, ...boundary ? [boundary.createdAt, boundary.createdAt, boundary.id] : [], limit + 1 - items.length) as { messageId: string, referencesJson: string }[]
        for (const row of rows) {
          const parsed = buddySessionReferencesSchema.safeParse(JSON.parse(row.referencesJson))
          if (parsed.success)
            items.push({ messageId: row.messageId, references: parsed.data })
        }
        if (items.length > limit)
          break
      }
      return { items: items.slice(0, limit), truncated: items.length > limit }
    },
    referenceIds(scope: SessionReferenceScope, messageId: string): string[] {
      const row = database.prepare(`SELECT messages.branch_id AS branchId, messages.created_at AS createdAt,
        json_extract(messages.content_json, '$.userContent.sessionReferences') AS referencesJson
        FROM messages JOIN conversation_publications publications ON publications.message_id = messages.id
        WHERE messages.id = ? AND messages.conversation_id = ? AND messages.role = 'user' AND publications.sequence <= ?`)
        .get(messageId, scope.conversationId, scope.throughSequence) as { branchId: string, createdAt: string, referencesJson: string | null } | undefined
      if (!row?.referencesJson)
        return []
      const segment = lineage.listVisibleSegments(scope.conversationId, scope.branchId).find(segment => segment.branchId === row.branchId)
      if (!segment || (segment.throughMessage && (row.createdAt > segment.throughMessage.createdAt || (row.createdAt === segment.throughMessage.createdAt && messageId > segment.throughMessage.id))))
        return []
      const parsed = buddySessionReferencesSchema.safeParse(JSON.parse(row.referencesJson))
      return parsed.success ? parsed.data.map(reference => reference.id) : []
    },
    exclusions(conversationId: string, branchId: string): string[] {
      return (database.prepare('SELECT session_id AS id FROM session_reference_exclusions WHERE conversation_id = ? AND branch_id = ? ORDER BY session_id')
        .all(conversationId, branchId) as { id: string }[]).map(row => row.id)
    },
  }
}

export type SessionReferenceRepository = ReturnType<typeof createSessionReferenceRepository>
