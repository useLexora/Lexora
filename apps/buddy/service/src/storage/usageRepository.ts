import type { DatabaseSync } from 'node:sqlite'

export interface UsageRecord {
  id: string
  runId: string | null
  invocationId?: string | null
  sourceEntryId: string
  provider: string
  model: string
  purpose: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number | null
  totalTokens: number
  inputCost: number
  outputCost: number
  cacheReadCost: number
  cacheWriteCost: number
  totalCost: number
  createdAt: string
}

export interface UsageTotals {
  cacheReadTokens: number
  cacheWriteTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  recordCount: number
  totalCost: number
  totalTokens: number
}

export interface UsageRepository {
  recordInvocation: (record: UsageRecord & { runId: null, invocationId: string }) => boolean

  findBySource: (runId: string, sourceEntryId: string, purpose: string) => UsageRecord | null
  listRecent: (limit?: number) => UsageRecord[]
  listForRun: (runId: string) => UsageRecord[]
  listForConversation: (conversationId: string) => UsageRecord[]
  summarize: () => UsageTotals
}

interface UsageRecordRow {
  id: string
  run_id: string | null
  invocation_id: string | null
  source_entry_id: string
  provider: string
  model: string
  purpose: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number | null
  total_tokens: number
  input_cost: number
  output_cost: number
  cache_read_cost: number
  cache_write_cost: number
  total_cost: number
  created_at: string
}

interface UsageTotalsRow {
  cache_read_tokens: number
  cache_write_tokens: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  record_count: number
  total_cost: number
  total_tokens: number
}

export function createUsageRepository(database: DatabaseSync): UsageRepository {
  const findBySource = database.prepare(`
    SELECT * FROM usage_records
    WHERE run_id = ? AND source_entry_id = ? AND purpose = ?
  `)
  const list = database.prepare(`
    SELECT * FROM usage_records WHERE run_id = ? ORDER BY created_at, id
  `)
  const listRecent = database.prepare(`
    SELECT * FROM usage_records ORDER BY created_at DESC, id DESC LIMIT ?
  `)
  const listForConversation = database.prepare(`
    SELECT usage.* FROM usage_records usage
    JOIN runs ON runs.id = usage.run_id
    WHERE runs.conversation_id = ?
    UNION ALL
    SELECT usage.* FROM usage_records usage
    JOIN extension_invocations invocations ON invocations.id = usage.invocation_id
    WHERE invocations.conversation_id = ?
    ORDER BY created_at, id
  `)
  const summarize = database.prepare(`
    SELECT
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COUNT(*) AS record_count,
      COALESCE(SUM(total_cost), 0) AS total_cost,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM usage_records
  `)

  return {
    recordInvocation(record) {
      return Number(database.prepare(`INSERT INTO usage_records (
        id, run_id, invocation_id, source_entry_id, provider, model, purpose,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens, input_cost, output_cost,
        cache_read_cost, cache_write_cost, total_cost, created_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(invocation_id, source_entry_id, purpose) DO NOTHING`).run(
        record.id,
        record.invocationId,
        record.sourceEntryId,
        record.provider,
        record.model,
        record.purpose,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheWriteTokens,
        record.reasoningTokens,
        record.totalTokens,
        record.inputCost,
        record.outputCost,
        record.cacheReadCost,
        record.cacheWriteCost,
        record.totalCost,
        record.createdAt,
      ).changes) === 1
    },
    findBySource(runId, sourceEntryId, purpose) {
      const row = findBySource.get(runId, sourceEntryId, purpose) as unknown as UsageRecordRow
        | undefined
      return row ? toUsageRecord(row) : null
    },
    listForRun(runId) {
      return (list.all(runId) as unknown as UsageRecordRow[]).map(toUsageRecord)
    },
    listForConversation(conversationId) {
      return (listForConversation.all(conversationId, conversationId) as unknown as UsageRecordRow[]).map(toUsageRecord)
    },
    listRecent(limit = 500) {
      return (listRecent.all(limit) as unknown as UsageRecordRow[]).map(toUsageRecord)
    },
    summarize() {
      const row = summarize.get() as unknown as UsageTotalsRow
      return {
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        reasoningTokens: row.reasoning_tokens,
        recordCount: row.record_count,
        totalCost: row.total_cost,
        totalTokens: row.total_tokens,
      }
    },
  }
}

function toUsageRecord(row: UsageRecordRow): UsageRecord {
  return {
    id: row.id,
    runId: row.run_id,
    invocationId: row.invocation_id,
    sourceEntryId: row.source_entry_id,
    provider: row.provider,
    model: row.model,
    purpose: row.purpose,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    inputCost: row.input_cost,
    outputCost: row.output_cost,
    cacheReadCost: row.cache_read_cost,
    cacheWriteCost: row.cache_write_cost,
    totalCost: row.total_cost,
    createdAt: row.created_at,
  }
}
