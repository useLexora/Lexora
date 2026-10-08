import type { DatabaseSync } from 'node:sqlite'
import type { LocalRunTokenUsage } from '../../../shared/usage/runTokenUsage'
import type { BuddyRunEvent } from '../events/BuddyRunEvent'
import type { MessageRecord } from './conversationHistoryRepository'
import type { RunRow } from './runRecord'
import { toRunRecord } from './runRecord'

export function createConversationTreeRepository(database: DatabaseSync) {
  const bind = database.prepare('INSERT INTO conversation_pi_trees (conversation_id, session_file, root_entry_id) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET session_file = excluded.session_file, root_entry_id = excluded.root_entry_id')
  return {
    ...createConversationTreeReader(database),
    bind: (conversationId: string, sessionFile: string, rootEntryId: string) => {
      bind.run(conversationId, sessionFile, rootEntryId)
    },
  }
}

export function createConversationTreeReader(database: DatabaseSync) {
  const binding = database.prepare('SELECT session_file AS sessionFile, root_entry_id AS rootEntryId FROM conversation_pi_trees WHERE conversation_id = ?')
  const source = database.prepare('SELECT source_run_id AS sourceRunId, position FROM run_tree_sources WHERE run_id = ?')
  const runs = database.prepare('SELECT * FROM runs WHERE conversation_id = ? ORDER BY started_at, id')
  const messages = database.prepare(`SELECT id, conversation_id AS conversationId,
    branch_id AS branchId, run_id AS runId, role,
    CASE WHEN role = 'assistant' THEN json_object('text', substr(COALESCE(
      CASE WHEN json_type(content_json) = 'text' THEN json_extract(content_json, '$')
      ELSE json_extract(content_json, '$.text') END, ''), 1, 4096))
      ELSE content_json END AS content_json,
    created_at AS createdAt
    FROM messages WHERE conversation_id = ? AND role IN ('user', 'assistant') ORDER BY created_at, id`)
  const tools = database.prepare(`SELECT run_events.run_id AS runId,
    COUNT(*) AS count
    FROM run_events INNER JOIN runs ON runs.id = run_events.run_id
    WHERE runs.conversation_id = ? AND event_type = 'tool.started' GROUP BY run_events.run_id`)
  const runMessages = database.prepare(`SELECT id, conversation_id AS conversationId,
    branch_id AS branchId, run_id AS runId, role, content_json, created_at AS createdAt
    FROM messages WHERE conversation_id = ? AND run_id = ? AND role = 'assistant' ORDER BY created_at, id`)
  const outputs = database.prepare(`SELECT run_events.run_id AS runId, run_events.created_at AS createdAt, payload_json
    FROM run_events INNER JOIN runs ON runs.id = run_events.run_id
    WHERE runs.conversation_id = ? AND event_type = 'output.produced' ORDER BY run_events.created_at, sequence`)
  const usage = database.prepare(`SELECT usage_records.run_id AS runId,
    SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
    SUM(cache_read_tokens) AS cacheReadTokens, SUM(cache_write_tokens) AS cacheWriteTokens
    FROM usage_records INNER JOIN runs ON runs.id = usage_records.run_id
    WHERE runs.conversation_id = ? GROUP BY usage_records.run_id`)

  return {
    listRunUsage: (conversationId: string): ReadonlyMap<string, LocalRunTokenUsage> =>
      new Map((usage.all(conversationId) as (LocalRunTokenUsage & { runId: string })[])
        .map(({ runId, ...tokens }) => [runId, tokens])),
    listOutputEvents: (conversationId: string): Pick<BuddyRunEvent, 'type' | 'runId' | 'createdAt' | 'payload'>[] =>
      (outputs.all(conversationId) as { runId: string, createdAt: string, payload_json: string }[])
        .map(({ payload_json, ...event }) => ({ ...event, type: 'output.produced', payload: JSON.parse(payload_json) })),
    listRunMessages: (conversationId: string, runId: string): MessageRecord[] =>
      (runMessages.all(conversationId, runId) as unknown as (Omit<MessageRecord, 'content'> & { content_json: string })[])
        .map(({ content_json, ...message }) => ({ ...message, content: JSON.parse(content_json) })),
    listMessages: (conversationId: string): MessageRecord[] => (messages.all(conversationId) as unknown as (Omit<MessageRecord, 'content'> & { content_json: string })[])
      .map(({ content_json, ...message }) => ({ ...message, content: JSON.parse(content_json) })),
    listToolCounts: (conversationId: string) => new Map((tools.all(conversationId) as { runId: string, count: number }[]).map(row => [row.runId, row.count])),
    findBinding: (conversationId: string) => binding.get(conversationId) as { sessionFile: string, rootEntryId: string } | undefined,
    findSource: (runId: string) => source.get(runId) as { sourceRunId: string, position: 'before' | 'after' } | undefined,
    listRuns: (conversationId: string) => (runs.all(conversationId) as unknown as RunRow[]).map(toRunRecord),
  }
}

export type ConversationTreeRepository = ReturnType<typeof createConversationTreeRepository>
