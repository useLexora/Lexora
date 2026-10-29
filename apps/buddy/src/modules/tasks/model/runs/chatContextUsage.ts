import type { LocalContextUsageSnapshot } from '@buddy-shared/conversation/contextApi'
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { ChatContextUsage, ChatContextUsageSegment } from './typing'
import { isChatModel } from '@buddy-shared/providers/providerModelType'

interface CreateChatContextUsageInput {
  events: ReadonlyArray<LocalRunEvent>
  models: ReadonlyArray<LocalRuntimeModelOption>
  selectedModel: LocalRuntimeModelOption | null
  snapshot?: LocalContextUsageSnapshot | null
}

interface ContextUsageValues {
  mcpTokens: number
  messageTokens: number
  modelId: string
  providerId: string
  skillTokens: number
  systemPromptTokens: number
  toolTokens: number
  totalTokens: number
}

interface AttributedContextUsage extends ContextUsageValues {
  event: LocalRunEvent
}

const EMPTY_SEGMENTS: ReadonlyArray<ChatContextUsageSegment> = [
  { kind: 'systemPrompt', tokens: 0 },
  { kind: 'tools', tokens: 0 },
  { kind: 'skills', tokens: 0 },
  { kind: 'mcp', tokens: 0 },
  { kind: 'messages', tokens: 0 },
]

export function createChatContextUsage(
  input: CreateChatContextUsageInput,
): ChatContextUsage | null {
  const recorded = latestAttributedContextUsage(input.events)
  const snapshot = readContextUsageSnapshot(input.snapshot)
  const pendingSnapshot = input.snapshot?.status === 'pending' ? input.snapshot : null
  const latestCompaction = input.events
    .filter(event => event.type === 'context.compaction.completed')
    .sort(compareEvents)
    .at(-1)
  const usage = pendingSnapshot
    ? null
    : latestCompaction
      ? recorded && compareEvents(recorded.event, latestCompaction) > 0
        ? recorded
        : null
      : snapshot && (!recorded || snapshot.createdAt >= recorded.event.createdAt)
        ? snapshot
        : recorded
  const usageModel = usage ?? pendingSnapshot
  const model = usageModel
    ? input.models.find(candidate => (
      candidate.providerId === usageModel.providerId
      && candidate.modelId === usageModel.modelId
    )) ?? input.selectedModel
    : input.selectedModel
  if (!model || !isChatModel(model))
    return null

  if (!usage) {
    return {
      contextWindow: model.contextWindow,
      modelName: model.displayName,
      modelId: model.modelId,
      percent: null,
      providerId: model.providerId,
      recordedAt: pendingSnapshot?.createdAt ?? null,
      segments: EMPTY_SEGMENTS,
      status: 'pending',
      totalTokens: null,
    }
  }

  const recordedAt = 'event' in usage ? usage.event.createdAt : usage.createdAt
  return readyContextUsage(usage, model, recordedAt)
}

function readyContextUsage(
  usage: ContextUsageValues & { contextWindow?: number },
  model: LocalRuntimeModelOption & { contextWindow: number },
  recordedAt: string,
): ChatContextUsage {
  return {
    contextWindow: usage.contextWindow ?? model.contextWindow,
    modelName: model.displayName,
    modelId: usage.modelId,
    percent: usage.totalTokens / (usage.contextWindow ?? model.contextWindow) * 100,
    providerId: usage.providerId,
    recordedAt,
    segments: [
      { kind: 'systemPrompt', tokens: usage.systemPromptTokens },
      { kind: 'tools', tokens: usage.toolTokens },
      { kind: 'skills', tokens: usage.skillTokens },
      { kind: 'mcp', tokens: usage.mcpTokens },
      { kind: 'messages', tokens: usage.messageTokens },
    ],
    status: 'ready',
    totalTokens: usage.totalTokens,
  }
}

function readContextUsageSnapshot(
  snapshot: LocalContextUsageSnapshot | null | undefined,
): (Omit<AttributedContextUsage, 'event'> & {
  contextWindow: number
  createdAt: string
}) | null {
  if (!snapshot || snapshot.status !== 'ready' || snapshot.totalTokens <= 0)
    return null
  return snapshot
}

function latestAttributedContextUsage(
  events: ReadonlyArray<LocalRunEvent>,
): AttributedContextUsage | null {
  let latest: AttributedContextUsage | null = null
  for (const event of events) {
    const usage = readAttributedContextUsage(event)
    if (!usage || usage.totalTokens <= 0)
      continue
    if (!latest || compareEvents(event, latest.event) > 0)
      latest = usage
  }
  return latest
}

function readAttributedContextUsage(event: LocalRunEvent): AttributedContextUsage | null {
  if (event.type !== 'context.usage.updated')
    return null

  const mcpTokens = readNonnegativeInteger(event.payload.mcpTokens)
  const messageTokens = readNonnegativeInteger(event.payload.messageTokens)
  const skillTokens = readNonnegativeInteger(event.payload.skillTokens)
  const systemPromptTokens = readNonnegativeInteger(event.payload.systemPromptTokens)
  const toolTokens = readNonnegativeInteger(event.payload.toolTokens)
  const totalTokens = readNonnegativeInteger(event.payload.totalTokens)
  const modelId = readNonemptyString(event.payload.model)
  const providerId = readNonemptyString(event.payload.provider)
  if (
    mcpTokens === null
    || messageTokens === null
    || skillTokens === null
    || systemPromptTokens === null
    || toolTokens === null
    || totalTokens === null
    || modelId === null
    || providerId === null
  ) {
    return null
  }

  if (
    mcpTokens
    + messageTokens
    + skillTokens
    + systemPromptTokens
    + toolTokens !== totalTokens
  ) {
    return null
  }

  return {
    event,
    mcpTokens,
    messageTokens,
    modelId,
    providerId,
    skillTokens,
    systemPromptTokens,
    toolTokens,
    totalTokens,
  }
}

function compareEvents(left: LocalRunEvent, right: LocalRunEvent): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.runId.localeCompare(right.runId)
    || left.sequence - right.sequence
}

function readNonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}
