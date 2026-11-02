import type { LocalContextUsageSnapshot } from '@buddy-shared/conversation/contextApi'
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { ChatContextUsage, ChatContextUsageSegment } from './typing'
import { isChatModel } from '@buddy-shared/providers/providerModelType'

interface CreateChatContextUsageInput {
  state: ChatContextUsageState | null
  models: ReadonlyArray<LocalRuntimeModelOption>
  selectedModel: LocalRuntimeModelOption | null
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

interface ContextUsagePosition {
  createdAt: string
  event?: Pick<LocalRunEvent, 'runId' | 'sequence'>
}

interface AttributedContextUsage extends ContextUsageValues {
  position: ContextUsagePosition
  contextWindow?: number
}

export interface ChatContextUsageState {
  reading: AttributedContextUsage | null
  compaction: ContextUsagePosition | null
  pending: Extract<LocalContextUsageSnapshot, { status: 'pending' }> | null
}

export function updateChatContextUsage(
  previous: ChatContextUsageState | null,
  input: { events?: ReadonlyArray<LocalRunEvent>, snapshot?: LocalContextUsageSnapshot },
): ChatContextUsageState {
  let state = previous ?? { reading: null, compaction: null, pending: null }
  const snapshot = input.snapshot
  if (snapshot?.status === 'pending') {
    state = { ...state, pending: snapshot }
    if (snapshot.reason === 'compaction')
      state = applyCompaction(state, { createdAt: snapshot.createdAt })
  }
  else if (snapshot) {
    state = applyReading(state, { ...snapshot, position: { createdAt: snapshot.createdAt } })
  }

  if (input.events) {
    const compaction = input.events.filter(event => event.type === 'context.compaction.completed').sort(compareEvents).at(-1)
    if (compaction)
      state = applyCompaction(state, { createdAt: compaction.createdAt, event: compaction })
    const reading = latestAttributedContextUsage(input.events)
    if (reading)
      state = applyReading(state, reading)
  }
  return state
}

function applyCompaction(state: ChatContextUsageState, position: ContextUsagePosition): ChatContextUsageState {
  if (state.compaction) {
    const order = comparePositions(position, state.compaction)
    if (order < 0 || (order === 0 && (state.compaction.event || !position.event)))
      return state
  }
  return {
    ...state,
    compaction: position,
    reading: state.reading?.position.event && comparePositions(state.reading.position, position) > 0 ? state.reading : null,
  }
}

function applyReading(state: ChatContextUsageState, reading: AttributedContextUsage): ChatContextUsageState {
  if (reading.totalTokens <= 0
    || (state.compaction && comparePositions(reading.position, state.compaction) <= 0)
    || (state.reading && comparePositions(reading.position, state.reading.position) < 0)) {
    return state
  }
  return { ...state, reading, pending: null }
}

function comparePositions(left: ContextUsagePosition, right: ContextUsagePosition): number {
  return left.createdAt.localeCompare(right.createdAt)
    || (left.event && right.event
      ? left.event.runId.localeCompare(right.event.runId) || left.event.sequence - right.event.sequence
      : 0)
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
  const usage = input.state?.reading
  const usageModel = usage ?? input.state?.pending
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
      recordedAt: input.state?.compaction?.createdAt ?? input.state?.pending?.createdAt ?? null,
      segments: EMPTY_SEGMENTS,
      status: 'pending',
      totalTokens: null,
    }
  }

  return readyContextUsage(usage, model, usage.position.createdAt)
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

function latestAttributedContextUsage(
  events: ReadonlyArray<LocalRunEvent>,
): AttributedContextUsage | null {
  let latest: AttributedContextUsage | null = null
  for (const event of events) {
    const usage = readAttributedContextUsage(event)
    if (!usage || usage.totalTokens <= 0)
      continue
    if (!latest || comparePositions(usage.position, latest.position) > 0)
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
    position: { createdAt: event.createdAt, event },
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
