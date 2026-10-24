import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { BuddyMessageQuote, BuddyResourceQuote, BuddyViewQuote } from '../../../shared/conversation/buddyUserContent'
import type { ConversationBranchLineage } from './conversationHistoryRepository'
import type { SessionReferenceScope } from './sessionReferenceRepository'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { BUDDY_TEXT_ATTACHMENT_MIME_TYPES } from '../../../shared/conversation/attachmentPolicy'
import { buddyMessageQuoteSchema, buddyResourceQuoteSchema, buddyUserMessageMaterialProjectionSchema, buddyUserMessageResourceSnapshotSchema, buddyViewQuoteSchema } from '../../../shared/conversation/buddyUserContent'
import { extensionReferenceTargetSchema } from '../../../shared/extensions/extensionReferences'

const inputProjectionSchema = z.object({
  materialProjection: buddyUserMessageMaterialProjectionSchema.optional(),
  resourceSnapshots: z.array(buddyUserMessageResourceSnapshotSchema).readonly(),
}).strict().refine((input) => {
  const resources = input.resourceSnapshots.map(resource => resource.resourceId)
  const deferred = input.materialProjection?.deferredResourceIds ?? []
  return new Set(resources).size === resources.length && new Set(deferred).size === deferred.length
    && deferred.every(id => input.resourceSnapshots.some(resource => resource.resourceId === id && resource.attachmentId))
})

interface ReferenceRow { value: string, message_id: string }
export interface ExtensionReferenceSnapshot { sourceMessageId: string, quote: BuddyViewQuote }
export type ReferenceSnapshot = { sourceMessageId: string } & (
  | { kind: 'message', quote: BuddyMessageQuote }
  | { kind: 'resource', quote: BuddyResourceQuote }
)
export interface ReferenceSnapshotQuery {
  sourceMessageId?: string
  referenceId?: string
  kind?: ReferenceSnapshot['kind']
  offset: number
  limit: number
}

export function createExtensionReferenceRepository(database: DatabaseSync, lineage: ConversationBranchLineage) {
  const committed = `EXISTS (SELECT 1 FROM runs WHERE runs.triggering_message_id = messages.id AND runs.execution_kind = 'root')
    OR EXISTS (SELECT 1 FROM chat_queue WHERE chat_queue.id = messages.id AND chat_queue.state = 'sent')`
  function inputs(scope: SessionReferenceScope) {
    const parameters: SQLInputValue[] = [scope.conversationId, scope.throughSequence]
    const segments = lineage.listVisibleSegments(scope.conversationId, scope.branchId).map((segment) => {
      parameters.push(segment.branchId)
      const through = segment.throughMessage
      if (!through)
        return '(messages.branch_id = ?)'
      parameters.push(through.createdAt, through.createdAt, through.id)
      return '(messages.branch_id = ? AND (messages.created_at < ? OR (messages.created_at = ? AND messages.id <= ?)))'
    })
    return {
      parameters,
      sql: `SELECT messages.content_json, messages.id AS message_id, publications.sequence
        FROM messages JOIN conversation_publications publications ON publications.message_id = messages.id
        WHERE messages.conversation_id = ? AND messages.role = 'user' AND (${committed})
          AND publications.sequence <= ? AND (${segments.join(' OR ') || '0'})`,
    }
  }
  return {
    inputProjection(conversationId: string, messageId: string) {
      const row = database.prepare(`SELECT
          json_extract(messages.content_json, '$.resourceSnapshots') AS resources_json,
          json_extract(messages.content_json, '$.materialProjection') AS projection_json
        FROM messages JOIN conversations ON conversations.id = messages.conversation_id
        WHERE messages.id = ? AND messages.conversation_id = ? AND messages.role = 'user'
          AND conversations.deleted_at IS NULL`).get(messageId, conversationId) as { resources_json: string | null, projection_json: string | null } | undefined
      if (!row)
        return null
      try {
        const parsed = inputProjectionSchema.safeParse({
          resourceSnapshots: row.resources_json === null ? null : JSON.parse(row.resources_json),
          materialProjection: row.projection_json === null ? undefined : JSON.parse(row.projection_json),
        })
        return parsed.success ? parsed.data : null
      }
      catch { return null }
    },
    attachmentSnapshots(scope: SessionReferenceScope, input: { sourceMessageId?: string, referenceId?: string, offset?: number, limit?: number } = {}) {
      const { parameters, sql } = inputs(scope)
      parameters.push(scope.conversationId, ...BUDDY_TEXT_ATTACHMENT_MIME_TYPES)
      if (input.sourceMessageId)
        parameters.push(input.sourceMessageId)
      if (input.referenceId)
        parameters.push(input.referenceId)
      const selection = `WITH inputs AS (${sql})
        SELECT resource.value, inputs.message_id, sequence FROM inputs,
          json_each(inputs.content_json, '$.resourceSnapshots') AS resource
        JOIN attachments ON attachments.id = json_extract(resource.value, '$.attachmentId')
        JOIN messages owner ON owner.id = attachments.message_id
        WHERE owner.conversation_id = ? AND attachments.draft_id IS NULL
          AND (attachments.mime_type LIKE 'text/%' OR attachments.mime_type IN (${BUDDY_TEXT_ATTACHMENT_MIME_TYPES.map(() => '?').join(', ')}))
          ${input.sourceMessageId ? 'AND inputs.message_id = ?' : ''}
          ${input.referenceId ? 'AND json_extract(resource.value, \'$.resourceId\') = ?' : ''}`
      const total = Number((database.prepare(`SELECT COUNT(*) AS total FROM (${selection})`).get(...parameters) as { total: number }).total)
      const rows = database.prepare(`${selection} ORDER BY sequence DESC, json_extract(value, '$.resourceId') LIMIT ? OFFSET ?`)
        .all(...parameters, input.limit ?? 20, input.offset ?? 0) as { value: string, message_id: string, sequence: number }[]
      const items = rows.flatMap((row) => {
        const parsed = buddyUserMessageResourceSnapshotSchema.safeParse(JSON.parse(row.value))
        return parsed.success && parsed.data.attachmentId ? [{ sourceMessageId: row.message_id, referenceId: parsed.data.resourceId, attachmentId: parsed.data.attachmentId, sequence: row.sequence }] : []
      })
      return { items, total }
    },
    activeScope(conversationId: string, runId: string): SessionReferenceScope | null {
      return database.prepare(`SELECT runs.conversation_id AS conversationId, runs.branch_id AS branchId,
        scopes.public_sequence AS throughSequence FROM runs
        JOIN run_session_reference_scopes scopes ON scopes.run_id = runs.id
        JOIN conversations ON conversations.id = runs.conversation_id
        WHERE runs.id = ? AND runs.conversation_id = ? AND runs.status = 'running'
          AND conversations.deleted_at IS NULL AND conversations.active_branch_id = runs.branch_id`)
        .get(runId, conversationId) as SessionReferenceScope | undefined ?? null
    },
    snapshots(scope: SessionReferenceScope, input: ReferenceSnapshotQuery) {
      const { parameters, sql } = inputs(scope)
      const filters = []
      if (input.sourceMessageId) {
        filters.push('message_id = ?')
        parameters.push(input.sourceMessageId)
      }
      if (input.referenceId) {
        filters.push('json_extract(value, \'$.id\') = ?')
        parameters.push(input.referenceId)
      }
      if (input.kind) {
        filters.push('kind = ?')
        parameters.push(input.kind)
      }
      const selection = `WITH inputs AS (${sql}), snapshots AS (
        SELECT quote.value, quote.key AS position, message_id, sequence, 'message' AS kind
          FROM inputs, json_each(inputs.content_json, '$.userContent.quotes') quote
        UNION ALL
        SELECT quote.value, quote.key AS position, message_id, sequence, 'resource' AS kind
          FROM inputs, json_each(inputs.content_json, '$.userContent.resourceQuotes') quote
      ) SELECT * FROM snapshots ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}`
      const total = Number((database.prepare(`SELECT COUNT(*) AS total FROM (${selection})`).get(...parameters) as { total: number }).total)
      const rows = database.prepare(`${selection} ORDER BY sequence DESC, kind, position LIMIT ? OFFSET ?`)
        .all(...parameters, input.limit, input.offset) as { value: string, kind: ReferenceSnapshot['kind'], message_id: string }[]
      const items: ReferenceSnapshot[] = []
      for (const row of rows) {
        const value: unknown = JSON.parse(row.value)
        if (row.kind === 'message') {
          const parsed = buddyMessageQuoteSchema.safeParse(value)
          if (parsed.success)
            items.push({ kind: 'message', quote: parsed.data, sourceMessageId: row.message_id })
        }
        else {
          const parsed = buddyResourceQuoteSchema.safeParse(value)
          if (parsed.success)
            items.push({ kind: 'resource', quote: parsed.data, sourceMessageId: row.message_id })
        }
      }
      return { items, total }
    },
    references(scope: SessionReferenceScope, extensionId: string, referenceId?: string, sourceMessageId?: string): ExtensionReferenceSnapshot[] {
      const { parameters, sql } = inputs(scope)
      parameters.push(`extension:${extensionId}`, extensionId)
      if (referenceId)
        parameters.push(referenceId)
      if (sourceMessageId)
        parameters.push(sourceMessageId)
      const rows = database.prepare(`WITH inputs AS (${sql})
        SELECT quote.value, message_id
        FROM inputs, json_each(inputs.content_json, '$.userContent.resourceQuotes') AS quote
        WHERE json_extract(quote.value, '$.source.kind') = 'view'
        AND json_extract(quote.value, '$.source.provider') = ?
        AND json_extract(quote.value, '$.source.target.extensionId') = ?
        ${referenceId ? 'AND json_extract(quote.value, \'$.id\') = ?' : ''}
        ${sourceMessageId ? 'AND message_id = ?' : ''}
        ORDER BY sequence DESC ${referenceId ? '' : 'LIMIT 101'}`).iterate(...parameters)
      const references: ExtensionReferenceSnapshot[] = []
      for (const value of rows) {
        const row = value as unknown as ReferenceRow
        const parsed = buddyViewQuoteSchema.safeParse(JSON.parse(row.value))
        if (!parsed.success)
          continue
        const quote = parsed.data
        const target = extensionReferenceTargetSchema.safeParse(quote.source.target)
        if (!target.success || target.data.extensionId !== extensionId)
          continue
        if (referenceId && references[0] && isDeepStrictEqual(references[0].quote, quote))
          continue
        references.push({ quote, sourceMessageId: row.message_id })
        if (references.length >= (referenceId ? 2 : 101))
          break
      }
      return references
    },
  }
}
export type ExtensionReferenceRepository = ReturnType<typeof createExtensionReferenceRepository>
