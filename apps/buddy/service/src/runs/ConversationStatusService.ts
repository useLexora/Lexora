import type { LocalConversationStatus } from '../../../shared/runs/conversationStatusApi'
import type { RunEventReader } from '../events/RunEventPorts'
import type { RunRecord } from '../storage/runRecord'
import type { RunRepository } from '../storage/runRepository'
import type { UsageRecord, UsageRepository } from '../storage/usageRepository'

export interface ConversationStatusOptions {
  events: Pick<RunEventReader, 'listForConversation'>
  repository: Pick<RunRepository, 'listForConversation'>
  usage: Pick<UsageRepository, 'listForRun'>
}

interface ConversationStatusEvent {
  createdAt: string
  payload: unknown
  runId: string
  sequence: number
  type: string
}

interface TokenCounts {
  cacheReadTokens: number
  cacheWriteTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  recordCount: number
  totalCost: number
  totalTokens: number
}

const RUN_LIMIT = 1_000
const EVENT_LIMIT = 20_000
const NAMED_LIMIT = 3

const RUN_PURPOSES = {
  automation: 'automation',
  chat: 'chat',
  compaction: 'conversation.compaction',
} as const

export class ConversationStatusService {
  readonly #options: ConversationStatusOptions

  constructor(options: ConversationStatusOptions) {
    this.#options = options
  }

  async status(conversationId: string): Promise<LocalConversationStatus> {
    const runs = this.#options.repository.listForConversation(conversationId, RUN_LIMIT)
    const events = await this.#options.events.listForConversation(conversationId, { limit: EVENT_LIMIT })
    const ordered = [...events].sort((left, right) => left.sequence - right.sequence)
    const usage = runs.flatMap(run => this.#options.usage.listForRun(run.id))

    return {
      activity: {
        compactions: foldCompactions(ordered),
        runs: {
          automation: tallyRuns(runs, RUN_PURPOSES.automation),
          chat: tallyRuns(runs, RUN_PURPOSES.chat),
          compaction: tallyRuns(runs, RUN_PURPOSES.compaction),
        },
        tools: foldTools(ordered),
        turns: new Set(runs
          .filter(run => run.purpose === RUN_PURPOSES.chat)
          .map(run => run.triggeringMessageId)).size,
      },
      timing: foldTiming(ordered, usage, new Set(runs.filter(run => run.purpose === RUN_PURPOSES.chat).map(run => run.id))),
      tokens: foldTokens(usage),
    }
  }
}

function emptyCounts(): TokenCounts {
  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    recordCount: 0,
    totalCost: 0,
    totalTokens: 0,
  }
}

function addRecord(counts: TokenCounts, record: UsageRecord): void {
  counts.cacheReadTokens += record.cacheReadTokens
  counts.cacheWriteTokens += record.cacheWriteTokens
  counts.inputTokens += record.inputTokens
  counts.outputTokens += record.outputTokens
  counts.reasoningTokens += record.reasoningTokens ?? 0
  counts.recordCount += 1
  counts.totalCost += record.totalCost
  counts.totalTokens += record.totalTokens
}

function foldTokens(usage: readonly UsageRecord[]) {
  const totals = emptyCounts()
  const byModel = new Map<string, TokenCounts & { modelId: string, providerId: string, runIds: Set<string> }>()
  const byPurpose = new Map<string, TokenCounts>()
  for (const record of usage) {
    addRecord(totals, record)
    const modelKey = `${record.provider}:${record.model}`
    const model = byModel.get(modelKey) ?? { ...emptyCounts(), modelId: record.model, providerId: record.provider, runIds: new Set<string>() }
    addRecord(model, record)
    model.runIds.add(record.runId)
    byModel.set(modelKey, model)
    const purpose = byPurpose.get(record.purpose) ?? emptyCounts()
    addRecord(purpose, record)
    byPurpose.set(record.purpose, purpose)
  }
  return {
    byModel: [...byModel.values()]
      .map(({ runIds, ...counts }) => ({ ...counts, runCount: runIds.size }))
      .sort((left, right) => right.totalTokens - left.totalTokens),
    byPurpose: [...byPurpose.entries()]
      .map(([purpose, counts]) => ({ ...counts, purpose }))
      .sort((left, right) => right.totalTokens - left.totalTokens),
    totals,
  }
}

function tallyRuns(runs: readonly RunRecord[], purpose: string) {
  const tally = { cancelled: 0, failed: 0, running: 0, succeeded: 0, total: 0 }
  for (const run of runs) {
    if (run.purpose !== purpose)
      continue
    tally.total += 1
    if (run.status === 'completed')
      tally.succeeded += 1
    else if (run.status === 'failed')
      tally.failed += 1
    else if (run.status === 'cancelled')
      tally.cancelled += 1
    else
      tally.running += 1
  }
  return tally
}

function readString(payload: unknown, key: string): string | null {
  if (payload === null || typeof payload !== 'object')
    return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(payload: unknown, key: string): number | null {
  if (payload === null || typeof payload !== 'object')
    return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function foldTools(events: readonly ConversationStatusEvent[]) {
  const calls = new Map<string, { name: string, startedAt: number | null, result: 'denied' | 'failed' | 'succeeded' | null }>()
  for (const event of events) {
    const toolCallId = readString(event.payload, 'toolCallId')
    if (!toolCallId)
      continue
    const name = readString(event.payload, 'toolName') ?? readString(event.payload, 'toolLabel') ?? 'tool'
    const call = calls.get(toolCallId) ?? { name, result: null, startedAt: null }
    call.name = name
    const at = Date.parse(event.createdAt)
    if (event.type === 'tool.started' || event.type === 'tool.preparing')
      call.startedAt ??= at
    else if (event.type === 'tool.completed')
      call.result = (event.payload as Record<string, unknown> | null)?.isError === true ? 'failed' : 'succeeded'
    else if (event.type === 'tool.failed')
      call.result = call.result ?? 'failed'
    else if (event.type === 'tool.denied')
      call.result = 'denied'
    calls.set(toolCallId, call)
  }
  const counts = new Map<string, number>()
  let denied = 0
  let failed = 0
  let running = 0
  let succeeded = 0
  for (const call of calls.values()) {
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
    if (call.result === 'denied')
      denied += 1
    else if (call.result === 'failed')
      failed += 1
    else if (call.result === 'succeeded')
      succeeded += 1
    else
      running += 1
  }
  return {
    denied,
    failed,
    running,
    succeeded,
    top: [...counts.entries()]
      .map(([name, count]) => ({ count, name }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .slice(0, NAMED_LIMIT),
    total: calls.size,
  }
}

function foldCompactions(events: readonly ConversationStatusEvent[]) {
  const completed = events.filter(event => event.type === 'context.compaction.completed')
  const last = completed.at(-1)
  return {
    count: completed.length,
    lastAfterTokens: last ? readNumber(last.payload, 'estimatedTokensAfter') : null,
    lastBeforeTokens: last ? readNumber(last.payload, 'tokensBefore') : null,
  }
}

function foldTiming(
  events: readonly ConversationStatusEvent[],
  usage: readonly UsageRecord[],
  chatRunIds: ReadonlySet<string>,
) {
  const messageStarts = new Map<string, number>()
  const firstNameBlock = new Map<string, number>()
  const messageEnds = new Map<string, number>()
  const openTools = new Map<string, { name: string, at: number }>()
  const toolDurations: { ms: number, name: string }[] = []
  let toolMs = 0
  for (const event of events) {
    const at = Date.parse(event.createdAt)
    const messageId = readString(event.payload, 'messageId')
    if (event.type === 'message.started' && messageId && chatRunIds.has(event.runId)) {
      messageStarts.set(messageId, at)
    }
    else if (event.type === 'message.block.started' && messageId && !firstNameBlock.has(messageId)) {
      firstNameBlock.set(messageId, at)
    }
    else if ((event.type === 'message.completed' || event.type === 'message.interrupted') && messageId) {
      messageEnds.set(messageId, at)
    }
    else if (event.type === 'tool.started' || event.type === 'tool.preparing') {
      const toolCallId = readString(event.payload, 'toolCallId')
      if (toolCallId)
        openTools.set(toolCallId, { at, name: readString(event.payload, 'toolName') ?? 'tool' })
    }
    else if (event.type === 'tool.completed' || event.type === 'tool.failed' || event.type === 'tool.denied') {
      const toolCallId = readString(event.payload, 'toolCallId')
      const open = toolCallId ? openTools.get(toolCallId) : null
      if (open && event.type === 'tool.completed') {
        const duration = Math.max(0, at - open.at)
        toolMs += duration
        toolDurations.push({ ms: duration, name: open.name })
      }
      if (toolCallId)
        openTools.delete(toolCallId)
    }
  }
  let modelMs = 0
  let ttftTotal = 0
  let ttftMax = 0
  let ttftSamples = 0
  let decodeMs = 0
  let decodeSamples = 0
  for (const [messageId, startedAt] of messageStarts) {
    const endedAt = messageEnds.get(messageId)
    const firstBlockAt = firstNameBlock.get(messageId)
    if (endedAt !== undefined)
      modelMs += Math.max(0, endedAt - startedAt)
    if (firstBlockAt !== undefined) {
      const ttft = Math.max(0, firstBlockAt - startedAt)
      ttftTotal += ttft
      ttftMax = Math.max(ttftMax, ttft)
      ttftSamples += 1
      if (endedAt !== undefined) {
        decodeMs += Math.max(0, endedAt - firstBlockAt)
        decodeSamples += 1
      }
    }
  }
  const outputTokens = usage
    .reduce((sum, record) => sum + (record.purpose === RUN_PURPOSES.chat ? record.outputTokens : 0), 0)
  const wall = foldWall(events)
  return {
    modelMs,
    slowestTools: toolDurations
      .sort((left, right) => right.ms - left.ms)
      .slice(0, NAMED_LIMIT),
    throughput: {
      samples: decodeSamples,
      tokensPerSecond: decodeMs > 0 ? (outputTokens / decodeMs) * 1_000 : 0,
    },
    toolMs,
    ttft: {
      averageMs: ttftSamples ? ttftTotal / ttftSamples : 0,
      maxMs: ttftMax,
      samples: ttftSamples,
    },
    wallMs: wall,
  }
}

function foldWall(events: readonly ConversationStatusEvent[]): number {
  const started = events.filter(event => event.type === 'run.started').map(event => Date.parse(event.createdAt))
  const ended = events
    .filter(event => event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled')
    .map(event => Date.parse(event.createdAt))
  if (!started.length)
    return 0
  const from = Math.min(...started)
  const to = ended.length ? Math.max(...ended) : Date.now()
  return Math.max(0, to - from)
}
