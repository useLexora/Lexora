import type { DatabaseSync } from 'node:sqlite'
import type { BuddyServiceTier, BuddyThinkingLevel } from '../../../shared/conversation/modelSelection'
import { z } from 'zod'
import { BUDDY_SERVICE_TIERS, BUDDY_THINKING_LEVELS } from '../../../shared/conversation/modelSelection'
import { skillReferenceSchema } from '../../../shared/skills/skillApi'

const contextItemSchema = z.object({
  kind: z.enum(['file', 'skill', 'slashCommand', 'sessionReference']),
  title: z.string().max(80).optional(),
  value: z.string().min(1),
  skill: skillReferenceSchema.optional(),
}).strict()

const attachmentIdsSchema = z.array(z.string().min(1))
const contextItemsSchema = z.array(contextItemSchema).max(64)
const reasoningSchema = z.enum(BUDDY_THINKING_LEVELS).nullable()
const serviceTierSchema = z.enum(BUDDY_SERVICE_TIERS).nullable()

export type RunInputContextItem = z.infer<typeof contextItemSchema>

export interface RunInputRecord {
  attachmentIds: string[]
  contextItems: RunInputContextItem[]
  createdAt: string
  prompt: string
  reasoning: BuddyThinkingLevel | null
  runId: string
  serviceTier: BuddyServiceTier | null
}

interface RunInputRow {
  attachment_ids_json: string
  context_items_json: string
  created_at: string
  prompt: string
  reasoning: string | null
  run_id: string
  service_tier: string | null
}

export interface RunInputRepository {
  findByMessageId: (messageId: string) => RunInputRecord | null
  findByRunId: (runId: string) => RunInputRecord | null
  findByTriggeringMessageId: (messageId: string) => RunInputRecord | null
}

export function createRunInputRepository(database: DatabaseSync): RunInputRepository {
  const findByRunId = database.prepare('SELECT * FROM run_inputs WHERE run_id = ?')
  const findByMessage = database.prepare(`
    SELECT run_inputs.*
    FROM run_inputs
    JOIN runs ON runs.id = run_inputs.run_id
    WHERE runs.triggering_message_id = ?
    ORDER BY runs.started_at DESC, runs.id DESC
    LIMIT 1
  `)
  const findQueuedInput = database.prepare(`
    SELECT run_id, created_at,
      json_extract(prepared_json, '$.runInput.attachmentIds') AS attachment_ids_json,
      json_extract(prepared_json, '$.runInput.contextItems') AS context_items_json,
      json_extract(prepared_json, '$.runInput.prompt') AS prompt,
      json_extract(prepared_json, '$.runInput.reasoning') AS reasoning,
      json_extract(prepared_json, '$.runInput.serviceTier') AS service_tier
    FROM chat_queue WHERE id = ? AND state = 'sent' AND run_id IS NOT NULL
  `)

  return {
    findByMessageId(messageId) {
      return toRecord(findByMessage.get(messageId) ?? findQueuedInput.get(messageId))
    },
    findByRunId(runId) {
      return toRecord(findByRunId.get(runId))
    },
    findByTriggeringMessageId(messageId) {
      return toRecord(findByMessage.get(messageId))
    },
  }
}

function toRecord(value: unknown): RunInputRecord | null {
  if (!value)
    return null
  const row = value as RunInputRow
  return {
    attachmentIds: attachmentIdsSchema.parse(JSON.parse(row.attachment_ids_json)),
    contextItems: contextItemsSchema.parse(JSON.parse(row.context_items_json)),
    createdAt: row.created_at,
    prompt: row.prompt,
    reasoning: reasoningSchema.parse(row.reasoning),
    runId: row.run_id,
    serviceTier: serviceTierSchema.parse(row.service_tier),
  }
}
