import type { DatabaseSync } from 'node:sqlite'
import type { LocalConversationStatus } from '../../../shared/runs/conversationStatusApi'
import type { UsageRecord, UsageTotals } from './usageRepository'
import { createConversationHistoryStore } from './conversationHistoryRepository'
import { createUsageRepository } from './usageRepository'

export interface ConversationStatisticsScope {
  conversationId: string
  branchId?: string
}

interface StatisticsRun {
  id: string
  purpose: string
  status: string
}

interface StatisticsEvent {
  sequence: number
  type: string
  createdAt: string
  messageId: string | null
  role: string | null
  stopReason: string | null
  toolCallId: string | null
  toolName: string | null
  isError: number | null
  tokensBefore: number | null
  tokensAfter: number | null
}

interface StatisticsPart {
  tokens: LocalConversationStatus['tokens']
  steps: number
  runs: LocalConversationStatus['activity']['runs']
  tools: LocalConversationStatus['activity']['tools']
  compactions: LocalConversationStatus['activity']['compactions']
  lastCompactionAt: string
  modelMs: number
  toolMs: number
  ttftTotal: number
  ttftMax: number
  ttftSamples: number
  decodeTokens: number
  decodeMs: number
  decodeSamples: number
  wallStart: number | null
  wallEnd: number | null
}

export interface ConversationStatisticsSnapshot {
  sequence: number
  scopeKey: string
  runs: ReadonlyMap<string, StatisticsPart>
  independentTokens: LocalConversationStatus['tokens']
  status: Omit<LocalConversationStatus, 'cacheWarming'>
  steps: number
  wallStart: number | null
  wallEnd: number | null
}

const CHANGE_LIMIT = 4096
const statisticEvents = [
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'message.started',
  'message.block.started',
  'message.completed',
  'message.interrupted',
  'tool.preparing',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'tool.denied',
  'context.compaction.completed',
]
const eventTypesSql = statisticEvents.map(type => `'${type}'`).join(', ')

export function createConversationStatisticsRepository(database: DatabaseSync) {
  const lineage = createConversationHistoryStore(database).lineage
  const usage = createUsageRepository(database)
  database.exec(`
    CREATE TEMP TABLE IF NOT EXISTS conversation_statistic_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      run_id TEXT,
      kind TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS temp.conversation_statistic_changes_conversation
      ON conversation_statistic_changes(conversation_id, id);
    CREATE TEMP TRIGGER IF NOT EXISTS conversation_statistic_changes_bound
    AFTER INSERT ON conversation_statistic_changes
    BEGIN DELETE FROM conversation_statistic_changes WHERE id <= NEW.id - ${CHANGE_LIMIT}; END;
    ${['INSERT', 'UPDATE', 'DELETE'].flatMap((operation) => {
      const rows = operation === 'UPDATE' ? ['OLD', 'NEW'] : [operation === 'DELETE' ? 'OLD' : 'NEW']
      return [
        `CREATE TEMP TRIGGER IF NOT EXISTS conversation_statistic_runs_${operation.toLowerCase()}
          AFTER ${operation} ON main.runs BEGIN
          ${rows.map(row => `INSERT INTO conversation_statistic_changes(conversation_id, run_id, kind)
            VALUES (${row}.conversation_id, ${row}.id, 'run');`).join('')}
          END;`,
        `CREATE TEMP TRIGGER IF NOT EXISTS conversation_statistic_events_${operation.toLowerCase()}
          AFTER ${operation} ON main.run_events
          WHEN ${rows.map(row => `${row}.event_type IN (${eventTypesSql})`).join(' OR ')}
          BEGIN
          ${rows.map(row => `INSERT INTO conversation_statistic_changes(conversation_id, run_id, kind)
            SELECT conversation_id, id, 'run' FROM runs WHERE id = ${row}.run_id;`).join('')}
          END;`,
        `CREATE TEMP TRIGGER IF NOT EXISTS conversation_statistic_usage_${operation.toLowerCase()}
          AFTER ${operation} ON main.usage_records BEGIN
          ${rows.map(row => `INSERT INTO conversation_statistic_changes(conversation_id, run_id, kind)
            SELECT conversation_id, id, 'run' FROM runs WHERE id = ${row}.run_id;
            INSERT INTO conversation_statistic_changes(conversation_id, kind)
            SELECT conversation_id, 'independent' FROM extension_invocations
              WHERE id = ${row}.invocation_id AND conversation_id IS NOT NULL;`).join('')}
          END;`,
        ...['messages', 'conversation_branches', 'conversation_publications', 'extension_invocations'].map(table => `
          CREATE TEMP TRIGGER IF NOT EXISTS conversation_statistic_${table}_${operation.toLowerCase()}
          AFTER ${operation}${table === 'messages' && operation === 'UPDATE' ? ' OF id, conversation_id, branch_id, run_id, role, created_at' : ''} ON main.${table}
          BEGIN
          ${rows.map(row => `INSERT INTO conversation_statistic_changes(conversation_id, kind)
            SELECT ${row}.conversation_id, 'scope' WHERE ${row}.conversation_id IS NOT NULL;`).join('')}
          END;
        `),
      ]
    }).join('')}
  `)
  const target = database.prepare(`
    SELECT 1 FROM conversations conversation
    WHERE conversation.id = ? AND conversation.deleted_at IS NULL
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM conversation_branches branch WHERE branch.conversation_id = conversation.id AND branch.id = ?
      ))
  `)
  const cursor = database.prepare(`
    SELECT COALESCE((SELECT seq FROM temp.sqlite_sequence WHERE name = 'conversation_statistic_changes'), 0) AS sequence,
      COALESCE(MIN(id), 0) AS first FROM conversation_statistic_changes
  `)
  const changes = database.prepare(`
    SELECT DISTINCT run_id AS runId, kind FROM conversation_statistic_changes
    WHERE conversation_id = ? AND id > ?
  `)
  const messageVisibility = `EXISTS (
    SELECT 1 FROM json_each(:segments) segment
    WHERE json_extract(segment.value, '$.branchId') = message.branch_id
      AND (json_extract(segment.value, '$.throughMessage') IS NULL
        OR message.created_at < json_extract(segment.value, '$.throughMessage.createdAt')
        OR (message.created_at = json_extract(segment.value, '$.throughMessage.createdAt')
          AND message.id <= json_extract(segment.value, '$.throughMessage.id')))
  )`
  const rootVisibility = `root.conversation_id = :conversationId
    AND root.execution_kind IN ('root', 'maintenance')
    AND root.purpose NOT IN ('cache_warm', 'extension.action')
    AND (
      (root.purpose = 'conversation.compaction' AND EXISTS (
        SELECT 1 FROM json_each(:segments) segment
        WHERE json_extract(segment.value, '$.branchId') = root.branch_id
          AND (json_extract(segment.value, '$.throughMessage') IS NULL
            OR root.started_at < json_extract(segment.value, '$.throughMessage.createdAt'))
      ))
      OR (root.purpose <> 'conversation.compaction' AND (
        EXISTS (SELECT 1 FROM messages message WHERE message.run_id = root.id
          AND message.conversation_id = :conversationId AND ${messageVisibility})
        OR (root.branch_id = :branchId AND EXISTS (
          SELECT 1 FROM messages message WHERE message.id = root.triggering_message_id
            AND message.role = 'user' AND message.conversation_id = :conversationId AND ${messageVisibility}
        ))
      ))
    )`
  const scopedRuns = database.prepare(`
    SELECT run.id, run.purpose, run.status FROM runs run
    JOIN runs root ON root.id = run.root_run_id
    WHERE run.conversation_id = :conversationId AND run.branch_id = root.branch_id
      AND run.purpose NOT IN ('cache_warm', 'extension.action') AND ${rootVisibility}
  `)
  const allRuns = database.prepare('SELECT id, purpose, status FROM runs WHERE conversation_id = ?')
  const turns = database.prepare(`
    SELECT COUNT(*) AS count FROM messages message
    WHERE message.conversation_id = :conversationId AND message.role = 'user'
      AND (:branchId IS NULL OR ${messageVisibility})
      AND (message.run_id IS NULL
        OR EXISTS (SELECT 1 FROM runs owner WHERE owner.id = message.run_id AND owner.execution_kind = 'root')
        OR EXISTS (SELECT 1 FROM conversation_publications publication WHERE publication.message_id = message.id))
  `)
  const events = database.prepare(`
    SELECT sequence, event_type AS type, created_at AS createdAt,
      json_extract(payload_json, '$.messageId') AS messageId,
      json_extract(payload_json, '$.role') AS role,
      json_extract(payload_json, '$.stopReason') AS stopReason,
      json_extract(payload_json, '$.toolCallId') AS toolCallId,
      COALESCE(json_extract(payload_json, '$.toolName'), json_extract(payload_json, '$.toolLabel')) AS toolName,
      json_extract(payload_json, '$.isError') AS isError,
      json_extract(payload_json, '$.tokensBefore') AS tokensBefore,
      json_extract(payload_json, '$.estimatedTokensAfter') AS tokensAfter
    FROM run_events WHERE run_id = ? AND event_type IN (${eventTypesSql}) ORDER BY sequence
  `)
  const independent = database.prepare(`
    SELECT usage.id, usage.provider, usage.model, usage.purpose, usage.run_id AS runId,
      usage.input_tokens AS inputTokens, usage.output_tokens AS outputTokens,
      usage.cache_read_tokens AS cacheReadTokens, usage.cache_write_tokens AS cacheWriteTokens,
      usage.reasoning_tokens AS reasoningTokens, usage.total_tokens AS totalTokens, usage.total_cost AS totalCost
    FROM extension_invocations invocation JOIN usage_records usage ON usage.invocation_id = invocation.id
    WHERE invocation.conversation_id = ?
  `)

  return {
    hasTarget: (scope: ConversationStatisticsScope): boolean =>
      Boolean(target.get(scope.conversationId, scope.branchId ?? null, scope.branchId ?? null)),
    read(scope: ConversationStatisticsScope, previous?: ConversationStatisticsSnapshot): ConversationStatisticsSnapshot {
      const { sequence, first } = cursor.get() as { sequence: number, first: number }
      const scopeKey = JSON.stringify([scope.conversationId, scope.branchId ?? null])
      if (!target.get(scope.conversationId, scope.branchId ?? null, scope.branchId ?? null))
        return combine(new Map(), foldTokens([]), 0, sequence, scopeKey)
      const reusable = previous?.scopeKey === scopeKey && previous.sequence <= sequence && previous.sequence >= first - 1
      const updates = reusable ? changes.all(scope.conversationId, previous.sequence) as { runId: string | null, kind: string }[] : []
      if (reusable && !updates.length)
        return previous.sequence === sequence ? previous : { ...previous, sequence }
      const rebuild = !reusable
      const changedRuns = new Set(updates.map(change => change.runId))
      const parameters = {
        conversationId: scope.conversationId,
        branchId: scope.branchId ?? null,
        segments: scope.branchId ? JSON.stringify(lineage.listVisibleSegments(scope.conversationId, scope.branchId)) : '[]',
      }
      const selected = (scope.branchId ? scopedRuns.all(parameters) : allRuns.all(scope.conversationId)) as unknown as StatisticsRun[]
      const parts = new Map<string, StatisticsPart>()
      for (const run of selected) {
        const cached = !rebuild && !changedRuns.has(run.id) ? previous?.runs.get(run.id) : undefined
        parts.set(run.id, cached ?? foldRun(run, events.all(run.id) as unknown as StatisticsEvent[], usage.listForRun(run.id).filter(record => !scope.branchId || !['cache_warm', 'extension.action'].includes(record.purpose))))
      }
      const independentTokens = scope.branchId
        ? foldTokens([])
        : !rebuild && !updates.some(change => change.kind === 'independent' || change.kind === 'scope')
            ? previous!.independentTokens
            : foldTokens(independent.all(scope.conversationId) as unknown as UsageRecord[])
      const totalTurns = (turns.get(parameters) as { count: number }).count
      return combine(parts, independentTokens, totalTurns, sequence, scopeKey)
    },
  }
}

export type ConversationStatisticsRepository = ReturnType<typeof createConversationStatisticsRepository>

function emptyCounts(): UsageTotals {
  return { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, recordCount: 0, totalCost: 0, totalTokens: 0 }
}

function addCounts(target: UsageTotals, source: UsageTotals): void {
  for (const key of Object.keys(emptyCounts()) as (keyof UsageTotals)[])
    target[key] += source[key]
}

function foldTokens(records: readonly UsageRecord[]): LocalConversationStatus['tokens'] {
  const totals = emptyCounts()
  const models = new Map<string, UsageTotals & { modelId: string, providerId: string, runIds: Set<string> }>()
  const purposes = new Map<string, UsageTotals>()
  for (const record of records) {
    const counts = { ...emptyCounts(), ...record, reasoningTokens: record.reasoningTokens ?? 0, recordCount: 1 }
    addCounts(totals, counts)
    const key = JSON.stringify([record.provider, record.model])
    const model = models.get(key) ?? { ...emptyCounts(), providerId: record.provider, modelId: record.model, runIds: new Set<string>() }
    addCounts(model, counts)
    if (record.runId)
      model.runIds.add(record.runId)
    models.set(key, model)
    const purpose = purposes.get(record.purpose) ?? emptyCounts()
    addCounts(purpose, counts)
    purposes.set(record.purpose, purpose)
  }
  return {
    totals,
    byModel: [...models.values()].map(({ runIds, ...counts }) => ({ ...counts, runCount: runIds.size })),
    byPurpose: [...purposes].map(([purpose, counts]) => ({ ...counts, purpose })),
  }
}

function emptyTally() {
  return { cancelled: 0, failed: 0, running: 0, succeeded: 0, total: 0 }
}

function foldRun(run: StatisticsRun, events: readonly StatisticsEvent[], usage: readonly UsageRecord[]): StatisticsPart {
  const part: StatisticsPart = {
    tokens: foldTokens(usage),
    steps: 0,
    runs: { automation: emptyTally(), chat: emptyTally(), compaction: emptyTally() },
    tools: { denied: 0, failed: 0, running: 0, succeeded: 0, total: 0, top: [] },
    compactions: { count: 0, lastAfterTokens: null, lastBeforeTokens: null },
    lastCompactionAt: '',
    modelMs: 0,
    toolMs: 0,
    ttftTotal: 0,
    ttftMax: 0,
    ttftSamples: 0,
    decodeTokens: 0,
    decodeMs: 0,
    decodeSamples: 0,
    wallStart: null,
    wallEnd: null,
  }
  const purpose = run.purpose === 'conversation.compaction' ? 'compaction' : run.purpose
  if (purpose === 'chat' || purpose === 'automation' || purpose === 'compaction') {
    const tally = { ...emptyTally(), total: 1 }
    const state = run.status === 'completed' ? 'succeeded' : run.status === 'failed' || run.status === 'cancelled' ? run.status : 'running'
    tally[state] = 1
    part.runs = { ...part.runs, [purpose]: tally }
  }
  const messages = new Map<string, { start?: number, block?: number, end?: number, failed: boolean }>()
  const tools = new Map<string, { name: string, start?: number, end?: number, result: 'denied' | 'failed' | 'succeeded' | 'running' }>()
  for (const event of events) {
    const at = Date.parse(event.createdAt)
    const validTime = Number.isFinite(at)
    if (validTime && event.type === 'run.started')
      part.wallStart = Math.min(part.wallStart ?? at, at)
    if (validTime && ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))
      part.wallEnd = Math.max(part.wallEnd ?? at, at)
    if (event.type === 'context.compaction.completed') {
      part.compactions = { count: part.compactions.count + 1, lastAfterTokens: event.tokensAfter, lastBeforeTokens: event.tokensBefore }
      part.lastCompactionAt = event.createdAt
    }
    if (typeof event.messageId === 'string' && event.messageId && !['cache_warm', 'extension.action'].includes(run.purpose)) {
      const message = messages.get(event.messageId) ?? { failed: false }
      if (event.type === 'message.started' && event.role === 'assistant') {
        if (!messages.has(event.messageId))
          part.steps += 1
        if (validTime)
          message.start ??= at
        messages.set(event.messageId, message)
      }
      else if (messages.has(event.messageId)) {
        if (event.type === 'message.block.started' && validTime && message.start !== undefined && message.end === undefined)
          message.block ??= at
        if (event.type === 'message.completed' || event.type === 'message.interrupted') {
          if (validTime)
            message.end ??= at
          message.failed ||= event.type === 'message.interrupted'
            || (event.stopReason !== null && !['completed', 'stop', 'length', 'tool_use', 'toolUse'].includes(event.stopReason))
        }
      }
    }
    if (typeof event.toolCallId === 'string' && event.toolCallId && event.type.startsWith('tool.')) {
      const call = tools.get(event.toolCallId) ?? { name: event.toolName ?? 'tool', result: 'running' }
      call.name = event.toolName ?? call.name
      if ((event.type === 'tool.started' || event.type === 'tool.preparing') && validTime)
        call.start ??= at
      if (event.type === 'tool.completed') {
        call.result = event.isError === 1 ? 'failed' : 'succeeded'
        if (validTime)
          call.end ??= at
      }
      else if (event.type === 'tool.failed' && call.result === 'running') {
        call.result = 'failed'
      }
      else if (event.type === 'tool.denied') {
        call.result = 'denied'
      }
      tools.set(event.toolCallId, call)
    }
  }
  const output = new Map(usage.filter(record => record.purpose === 'turn').map(record => [record.sourceEntryId, record.outputTokens]))
  for (const [id, message] of messages) {
    const { start, block, end } = message
    if (start === undefined)
      continue
    if (end !== undefined && end >= start)
      part.modelMs += end - start
    if (block === undefined || block < start)
      continue
    const ttft = block - start
    part.ttftTotal += ttft
    part.ttftMax = Math.max(part.ttftMax, ttft)
    part.ttftSamples += 1
    const tokens = output.get(id)
    if (end === undefined || end <= block || message.failed || !tokens || tokens <= 0)
      continue
    part.decodeSamples += 1
    part.decodeMs += end - block
    part.decodeTokens += tokens
  }
  const toolCounts = new Map<string, number>()
  const tally = { denied: 0, failed: 0, running: 0, succeeded: 0, total: tools.size }
  for (const call of tools.values()) {
    tally[call.result] += 1
    toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1)
    if (call.start !== undefined && call.end !== undefined)
      part.toolMs += Math.max(0, call.end - call.start)
  }
  part.tools = { ...tally, top: [...toolCounts].map(([name, count]) => ({ name, count })) }
  return part
}

function combine(
  runs: ReadonlyMap<string, StatisticsPart>,
  independentTokens: LocalConversationStatus['tokens'],
  turns: number,
  sequence: number,
  scopeKey: string,
): ConversationStatisticsSnapshot {
  const parts = [...runs.values()]
  const tokens = [...parts.map(part => part.tokens), independentTokens]
  const totals = emptyCounts()
  const models = new Map<string, UsageTotals & { providerId: string, modelId: string, runCount: number }>()
  const purposes = new Map<string, UsageTotals & { purpose: string }>()
  for (const token of tokens) {
    addCounts(totals, token.totals)
    for (const model of token.byModel) {
      const key = JSON.stringify([model.providerId, model.modelId])
      const combined = models.get(key) ?? { ...emptyCounts(), providerId: model.providerId, modelId: model.modelId, runCount: 0 }
      addCounts(combined, model)
      combined.runCount += model.runCount
      models.set(key, combined)
    }
    for (const purpose of token.byPurpose) {
      const combined = purposes.get(purpose.purpose) ?? { ...emptyCounts(), purpose: purpose.purpose }
      addCounts(combined, purpose)
      purposes.set(purpose.purpose, combined)
    }
  }
  const tally = { automation: emptyTally(), chat: emptyTally(), compaction: emptyTally() }
  const tools = { denied: 0, failed: 0, running: 0, succeeded: 0, total: 0 }
  const namedTools = new Map<string, number>()
  let compactions = 0
  let latest: StatisticsPart | undefined
  let steps = 0
  let modelMs = 0
  let toolMs = 0
  let ttftTotal = 0
  let ttftMax = 0
  let ttftSamples = 0
  let decodeTokens = 0
  let decodeMs = 0
  let decodeSamples = 0
  let wallStart: number | null = null
  let wallEnd: number | null = null
  for (const part of parts) {
    steps += part.steps
    modelMs += part.modelMs
    toolMs += part.toolMs
    ttftTotal += part.ttftTotal
    ttftMax = Math.max(ttftMax, part.ttftMax)
    ttftSamples += part.ttftSamples
    decodeTokens += part.decodeTokens
    decodeMs += part.decodeMs
    decodeSamples += part.decodeSamples
    if (part.wallStart !== null)
      wallStart = Math.min(wallStart ?? part.wallStart, part.wallStart)
    if (part.wallEnd !== null)
      wallEnd = Math.max(wallEnd ?? part.wallEnd, part.wallEnd)
    for (const purpose of ['automation', 'chat', 'compaction'] as const) {
      for (const key of Object.keys(tally[purpose]) as (keyof ReturnType<typeof emptyTally>)[])
        tally[purpose][key] += part.runs[purpose][key]
    }
    for (const key of Object.keys(tools) as (keyof typeof tools)[])
      tools[key] += part.tools[key]
    for (const entry of part.tools.top)
      namedTools.set(entry.name, (namedTools.get(entry.name) ?? 0) + entry.count)
    compactions += part.compactions.count
    if (!latest || part.lastCompactionAt > latest.lastCompactionAt)
      latest = part
  }
  return {
    sequence,
    scopeKey,
    runs,
    independentTokens,
    steps,
    wallStart,
    wallEnd,
    status: {
      activity: {
        turns,
        runs: tally,
        tools: { ...tools, top: [...namedTools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 3) },
        compactions: { count: compactions, lastAfterTokens: latest?.compactions.lastAfterTokens ?? null, lastBeforeTokens: latest?.compactions.lastBeforeTokens ?? null },
      },
      timing: {
        modelMs,
        toolMs,
        wallMs: wallStart === null ? 0 : Math.max(0, (wallEnd ?? Date.now()) - wallStart),
        ttft: { samples: ttftSamples, maxMs: ttftMax, averageMs: ttftSamples ? ttftTotal / ttftSamples : 0 },
        throughput: { samples: decodeSamples, tokensPerSecond: decodeMs > 0 ? decodeTokens * 1000 / decodeMs : null },
      },
      tokens: {
        totals,
        byModel: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens),
        byPurpose: [...purposes.values()].sort((a, b) => b.totalTokens - a.totalTokens),
      },
    },
  }
}
