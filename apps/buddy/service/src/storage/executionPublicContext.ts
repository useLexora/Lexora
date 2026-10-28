import type { DatabaseSync } from 'node:sqlite'
import type { ExecutionMailboxMessage } from '../../../shared/executions/executionApi'
import type { RunRecord } from './runRecord'
import { MAX_BUDDY_MESSAGE_TEXT_LENGTH } from '../../../shared/conversation/buddyMessageContent'
import { buddyUserContentToText, readBuddyUserMessageContent } from '../../../shared/conversation/buddyUserContent'
import { executionMailboxMessageSchema } from '../../../shared/executions/executionApi'
import { readPublicMessageText } from '../conversations/publicConversationContext'

interface InputRow {
  sourceId: string
  messageId: string
  sequence: number
  contentJson: string
  hasMaterials: number
  actorId: string
  acceptedAt: string
  initialInput: number
}

const acceptedInput = `(
  (owner.execution_kind = 'root' AND owner.triggering_message_id = messages.id)
  OR EXISTS (SELECT 1 FROM chat_queue queue WHERE queue.run_id = owner.id AND queue.state = 'sent'
    AND queue.conversation_id = owner.conversation_id AND queue.branch_id = owner.branch_id
    AND json_extract(queue.prepared_json, '$.userMessageId') = messages.id)
)`

const publicActor = `owner.execution_kind IN ('root', 'actor_child')
  AND json_extract(owner.actor_snapshot_json, '$.kind') = 'actor'`

function readForwardableUserText(content: unknown, actorId: string): string | null {
  if (typeof content === 'string')
    return content.length > 0 && content.length <= MAX_BUDDY_MESSAGE_TEXT_LENGTH ? content : null
  const structured = readBuddyUserMessageContent(content)
  if (structured) {
    const user = structured.userContent
    const mentions = user.body.flatMap(paragraph => paragraph.content.filter(node => node.type === 'actor_ref'))
    if (mentions.length > 1 || mentions.some(mention => mention.actorId !== actorId))
      return null
    if (structured.resourceSnapshots.length || user.panelResourceIds.length || user.quotes?.length
      || user.resourceQuotes?.length || user.sessionReferences?.length
      || user.body.some(paragraph => paragraph.content.some(node => node.type !== 'text' && node.type !== 'hard_break' && node.type !== 'actor_ref'))) {
      return null
    }
    return readForwardableUserText(buddyUserContentToText(user), actorId)
  }
  if (content && typeof content === 'object' && Object.keys(content).length === 1 && 'text' in content)
    return readForwardableUserText(content.text, actorId)
  return null
}

export function createExecutionPublicContext(database: DatabaseSync) {
  const inputs = `SELECT publications.source_id AS sourceId, messages.id AS messageId,
    publications.sequence, messages.content_json AS contentJson, owner.buddy_id AS actorId,
    messages.created_at AS acceptedAt,
    (owner.execution_kind = 'root' AND owner.triggering_message_id = messages.id) AS initialInput,
    (EXISTS (SELECT 1 FROM attachments WHERE message_id = messages.id)
      OR EXISTS (SELECT 1 FROM run_inputs WHERE run_id = owner.id AND owner.triggering_message_id = messages.id
        AND (json_array_length(attachment_ids_json) > 0 OR json_array_length(context_items_json) > 0))
      OR EXISTS (SELECT 1 FROM chat_queue queue WHERE queue.run_id = owner.id AND queue.state = 'sent'
        AND queue.conversation_id = owner.conversation_id AND queue.branch_id = owner.branch_id
        AND json_extract(queue.prepared_json, '$.userMessageId') = messages.id
        AND (json_array_length(queue.prepared_json, '$.runInput.attachmentIds') > 0
          OR json_array_length(queue.prepared_json, '$.runInput.contextItems') > 0))) AS hasMaterials
    FROM runs owner JOIN messages ON messages.conversation_id = owner.conversation_id AND messages.branch_id = owner.branch_id
    JOIN conversation_publications publications ON publications.message_id = messages.id
      AND publications.conversation_id = owner.conversation_id AND publications.branch_id = owner.branch_id
    WHERE owner.id = ? AND ${publicActor} AND messages.role = 'user' AND ${acceptedInput}`

  function presentInput(row: InputRow) {
    const content: unknown = JSON.parse(row.contentJson)
    const text = row.hasMaterials ? null : readForwardableUserText(content, row.actorId)
    return { sourceId: row.sourceId, messageId: row.messageId, sequence: row.sequence, text, excerpt: (text ?? readPublicMessageText(content, 'user', row.messageId)).slice(0, 240), forwardable: text !== null }
  }

  function isForwardedInput(message: ExecutionMailboxMessage): boolean {
    if (message.kind !== 'supplement' || message.origin !== 'user' || message.purpose
      || message.sourceRunId !== message.targetRunId) {
      return false
    }
    const row = database.prepare(`SELECT owner.id, publications.source_id AS sourceId FROM runs owner
      JOIN runs target ON target.id = ? AND target.conversation_id = owner.conversation_id AND target.branch_id = owner.branch_id
      JOIN messages ON messages.id = ? AND messages.conversation_id = owner.conversation_id AND messages.branch_id = owner.branch_id
      JOIN conversation_publications publications ON publications.message_id = messages.id
      WHERE owner.id <> target.id AND ${publicActor} AND messages.role = 'user' AND ${acceptedInput}
      ORDER BY owner.started_at DESC LIMIT 1`).get(message.targetRunId, message.messageId)
    if (!row)
      return false
    const input = database.prepare(`${inputs} AND publications.source_id = ?`).get(row.id, row.sourceId) as unknown as InputRow | undefined
    return !!input && presentInput(input).text === message.text
  }

  function hasLaterHumanInput(runId: string, input: InputRow): boolean {
    const rows = database.prepare(`SELECT mailbox.payload_json FROM execution_mailbox_sources mailbox
      JOIN runs owner ON owner.id = mailbox.target_run_id AND owner.id = mailbox.source_run_id
      WHERE owner.id = ? AND mailbox.target_generation = owner.generation
        AND (? = 1 OR mailbox.created_at > ?)
        AND NOT EXISTS (SELECT 1 FROM execution_mailbox_receipts receipt WHERE receipt.mailbox_id = mailbox.id AND receipt.kind = 'rejected')
        AND ((json_extract(mailbox.payload_json, '$.kind') = 'supplement'
            AND json_extract(mailbox.payload_json, '$.origin') = 'user'
            AND json_extract(mailbox.payload_json, '$.purpose') IS NULL)
          OR (json_extract(mailbox.payload_json, '$.kind') = 'answer'
            AND EXISTS (SELECT 1 FROM execution_mailbox_sources question
              WHERE question.source_run_id = owner.id AND question.target_run_id = owner.id
                AND question.target_generation = owner.generation AND question.source_sequence < mailbox.source_sequence
                AND json_extract(question.payload_json, '$.kind') = 'question'
                AND json_extract(question.payload_json, '$.audience') = 'user'
                AND json_extract(question.payload_json, '$.questionId') = json_extract(mailbox.payload_json, '$.questionId')
                AND NOT EXISTS (SELECT 1 FROM execution_mailbox_receipts receipt WHERE receipt.mailbox_id = question.id AND receipt.kind = 'rejected'))))
      ORDER BY mailbox.source_sequence DESC`).iterate(runId, input.initialInput, input.acceptedAt)
    for (const row of rows) {
      const message = executionMailboxMessageSchema.parse(JSON.parse(row.payload_json as string))
      if (!isForwardedInput(message))
        return true
    }
    return false
  }

  const visibleWork = `SELECT target.id, MAX(publications.sequence) AS publicSequence
    FROM runs target
    JOIN conversation_publications publications ON publications.conversation_id = target.conversation_id
      AND publications.branch_id = target.branch_id AND publications.sequence <= ?
    LEFT JOIN messages ON messages.id = publications.message_id
    WHERE target.conversation_id = ? AND target.branch_id = ?
      AND target.execution_kind IN ('root', 'actor_child')
      AND json_extract(target.actor_snapshot_json, '$.kind') = 'actor'
      AND target.id <> ?
      AND ((publications.run_id = target.id AND (publications.kind = 'output' OR messages.role = 'assistant'))
        OR (target.execution_kind = 'root' AND publications.message_id = target.triggering_message_id AND messages.role = 'user'))`

  return {
    listInputs(runId: string, offset: number, limit: number) {
      return (database.prepare(`${inputs} ORDER BY publications.sequence DESC LIMIT ? OFFSET ?`)
        .all(runId, limit, offset) as unknown as InputRow[]).map(presentInput)
    },
    findInput(runId: string, sourceId: string) {
      const row = database.prepare(`${inputs} AND publications.source_id = ?`).get(runId, sourceId) as unknown as InputRow | undefined
      return row ? presentInput(row) : null
    },
    findForwardGuardInput(runId: string) {
      const input = database.prepare(`${inputs} ORDER BY publications.sequence DESC LIMIT 1`).get(runId) as unknown as InputRow | undefined
      return input && !hasLaterHumanInput(runId, input) ? presentInput(input) : null
    },
    listWorks(caller: RunRecord, boundary: number, offset: number, limit: number) {
      return database.prepare(`${visibleWork} GROUP BY target.id ORDER BY publicSequence DESC, target.id DESC LIMIT ? OFFSET ?`)
        .all(boundary, caller.conversationId, caller.branchId, caller.id, limit, offset) as { id: string }[]
    },
    hasWork(caller: RunRecord, boundary: number, runId: string) {
      return !!database.prepare(`${visibleWork} AND target.id = ? GROUP BY target.id`)
        .get(boundary, caller.conversationId, caller.branchId, caller.id, runId)
    },
    readTask(run: RunRecord, boundary: number): string {
      const row = database.prepare(`SELECT messages.content_json AS content, messages.role
        FROM conversation_publications publications JOIN messages ON messages.id = publications.message_id
        WHERE publications.conversation_id = ? AND publications.branch_id = ? AND publications.sequence <= ?
          AND ((publications.message_id = ? AND messages.role = 'user') OR (publications.run_id = ? AND messages.role = 'assistant'))
        ORDER BY publications.sequence LIMIT 1`).get(run.conversationId, run.branchId, boundary, run.triggeringMessageId, run.id)
      return row ? readPublicMessageText(JSON.parse(row.content as string), row.role as 'user' | 'assistant').slice(0, 300) : ''
    },
    readReply(run: RunRecord) {
      const row = database.prepare(`SELECT publications.source_id AS sourceId, messages.id AS messageId, messages.content_json AS content
        FROM conversation_publications publications JOIN messages ON messages.id = publications.message_id
        JOIN run_events events ON events.run_id = publications.run_id AND events.sequence = publications.source_sequence
        WHERE publications.run_id = ? AND publications.conversation_id = ? AND publications.branch_id = ?
          AND messages.role = 'assistant' AND messages.run_id = publications.run_id
          AND events.event_type = 'message.completed'
          AND json_extract(events.payload_json, '$.messageId') = messages.id
          AND COALESCE(json_extract(events.payload_json, '$.phase'), 'final') <> 'commentary'
          AND COALESCE(json_extract(events.payload_json, '$.stopReason'), 'completed') = 'completed'
          AND length(trim(CASE WHEN json_type(messages.content_json) = 'text'
            THEN json_extract(messages.content_json, '$') ELSE json_extract(messages.content_json, '$.text') END)) > 0
        ORDER BY publications.sequence DESC LIMIT 1`).get(run.id, run.conversationId, run.branchId)
      return row
        ? { sourceId: row.sourceId as string, messageId: row.messageId as string, text: readPublicMessageText(JSON.parse(row.content as string), 'assistant') }
        : null
    },
    isForwardedInput,
  }
}
