import type {
  ChatMessage,
  ChatSessionUsageSummary,
  ChatTokenUsageAggregate,
} from '@/apis/chat'
import {
  estimateChatTextTokens,
  formatChatTokenCount,
} from '@/composables/chat/utils/chat-token-estimate'
import { translate } from '@/i18n'

type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>
type AssistantUsage = NonNullable<NonNullable<AssistantMessage['metadata']>['usage']>
type ContextBudget = NonNullable<AssistantUsage['contextBudget']>

export interface ChatUsageDetailRow {
  label: string
  value: string
  tone?: 'default' | 'warning' | 'muted'
}

export interface ChatConversationBudgetView {
  usedPercent: number
  fillPercent: number
  usedText: string
  sourceText: string
  rows: ChatUsageDetailRow[]
}

export interface ChatConversationUsageView {
  summaryRows: ChatUsageDetailRow[]
  latestRows: ChatUsageDetailRow[]
  budget: ChatConversationBudgetView | null
  notes: string[]
}

export interface ChatMessageUsageView {
  title: string
  summary: string
  rows: ChatUsageDetailRow[]
  notes: string[]
  estimated: boolean
}

export function createChatConversationUsageView(
  usage: ChatSessionUsageSummary | undefined,
  messages: ChatMessage[],
): ChatConversationUsageView {
  const latestUsage = getLatestAssistantUsage(messages)
  const usageSummary = usage ?? {
    activePath: createEmptyUsageAggregate(),
    session: createEmptyUsageAggregate(),
  }
  const budget = latestUsage?.contextBudget ? createBudgetView(latestUsage.contextBudget) : null
  const siblingUsage = subtractUsage(usageSummary.session, usageSummary.activePath)

  return {
    summaryRows: [
      createAggregateRow(translate('chat.usage.activePath'), usageSummary.activePath),
      createAggregateRow(translate('chat.usage.sessionTotal'), usageSummary.session),
      createAggregateRow(translate('chat.usage.siblingUsage'), siblingUsage, siblingUsage.totalTokens > 0 ? 'warning' : 'muted'),
    ],
    latestRows: latestUsage ? createAssistantUsageRows(latestUsage) : [],
    budget,
    notes: [
      messages.length === 0 ? translate('chat.usage.noUsage') : null,
      translate('chat.usage.activePathNote'),
      translate('chat.usage.sessionTotalNote'),
    ].filter(Boolean) as string[],
  }
}

export function createChatMessageUsageView(message: ChatMessage): ChatMessageUsageView | null {
  if (message.role === 'assistant') {
    const usage = message.metadata?.usage
    const fallbackOutputTokens = estimateChatTextTokens(message.content)

    return {
      title: translate('chat.usage.replyTitle'),
      summary: usage
        ? `${formatChatTokenCount(usage.totalTokens)} tokens`
        : fallbackOutputTokens > 0
          ? translate('chat.usage.approximateTokens', { tokens: formatChatTokenCount(fallbackOutputTokens) })
          : translate('chat.usage.notRecorded'),
      rows: usage
        ? createAssistantUsageRows(usage)
        : [
            { label: translate('chat.usage.input'), value: translate('chat.usage.notRecorded'), tone: 'muted' },
            {
              label: translate('chat.usage.output'),
              value: fallbackOutputTokens > 0
                ? translate('chat.usage.approximateTokens', { tokens: formatChatTokenCount(fallbackOutputTokens) })
                : translate('chat.usage.notRecorded'),
              tone: fallbackOutputTokens > 0 ? 'warning' : 'muted',
            },
            {
              label: translate('chat.usage.total'),
              value: fallbackOutputTokens > 0
                ? translate('chat.usage.atLeastApproximateTokens', { tokens: formatChatTokenCount(fallbackOutputTokens) })
                : translate('chat.usage.notRecorded'),
              tone: fallbackOutputTokens > 0 ? 'warning' : 'muted',
            },
            { label: translate('chat.usage.source'), value: translate('chat.usage.missingHistoryStats'), tone: 'muted' },
          ],
      notes: usage
        ? usage.estimated ? [translate('chat.usage.estimatedFieldsNote')] : []
        : [translate('chat.usage.missingHistoricalUsageNote')],
      estimated: usage?.estimated ?? true,
    }
  }

  const textTokens = estimateChatTextTokens(message.content)
  const attachmentCount = message.metadata.attachments.length
  const snapshotCount = message.metadata.contextSnapshotMetas.length

  return {
    title: translate('chat.usage.userInputTitle'),
    summary: translate('chat.usage.approximateTokens', { tokens: formatChatTokenCount(textTokens) }),
    rows: [
      { label: translate('chat.usage.messageBody'), value: translate('chat.usage.approximateTokens', { tokens: formatChatTokenCount(textTokens) }) },
      { label: translate('chat.usage.attachments'), value: translate('chat.usage.count', { count: attachmentCount }), tone: attachmentCount > 0 ? 'warning' : 'muted' },
      { label: translate('chat.usage.contextSnapshots'), value: translate('chat.usage.count', { count: snapshotCount }), tone: snapshotCount > 0 ? 'warning' : 'muted' },
    ],
    notes: [translate('chat.usage.userInputEstimateNote')],
    estimated: true,
  }
}

function getLatestAssistantUsage(messages: ChatMessage[]): AssistantUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && message.metadata?.usage) {
      return message.metadata.usage
    }
  }

  return null
}

function createAssistantUsageRows(usage: AssistantUsage): ChatUsageDetailRow[] {
  return [
    { label: translate('chat.usage.input'), value: `${formatChatTokenCount(usage.inputTokens)} tokens` },
    { label: translate('chat.usage.output'), value: `${formatChatTokenCount(usage.outputTokens)} tokens` },
    usage.reasoningTokens > 0
      ? { label: translate('chat.usage.reasoning'), value: `${formatChatTokenCount(usage.reasoningTokens)} tokens` }
      : null,
    usage.memoryRetrieval
      ? {
          label: translate('chat.usage.longTermMemory'),
          value: usage.memoryRetrieval.ignoredForRun
            ? translate('chat.usage.ignoredThisRun')
            : translate('chat.usage.memoryInjected', {
                count: usage.memoryRetrieval.injectedCount,
                tokens: formatChatTokenCount(usage.memoryRetrieval.estimatedTokens),
              }),
          tone: usage.memoryRetrieval.injectedCount > 0 ? 'default' : 'muted',
        }
      : null,
    { label: translate('chat.usage.total'), value: `${formatChatTokenCount(usage.totalTokens)} tokens` },
    typeof usage.firstTokenLatencyMs === 'number'
      ? { label: translate('chat.usage.firstTokenLatency'), value: `${formatExactCount(usage.firstTokenLatencyMs)} ms` }
      : null,
    typeof usage.tokensPerSecond === 'number'
      ? { label: translate('chat.usage.generationSpeed'), value: `${usage.tokensPerSecond.toFixed(1)} tokens/s` }
      : null,
    {
      label: translate('chat.usage.source'),
      value: formatUsageSource(usage.usageSource),
      tone: usage.estimated ? 'warning' : 'default',
    },
  ].filter(Boolean) as ChatUsageDetailRow[]
}

function createBudgetView(budget: ContextBudget): ChatConversationBudgetView {
  const contextWindow = normalizeTokenCount(budget.contextWindow)
  const reservedOutputTokens = normalizeTokenCount(budget.reservedOutputTokens)
  const systemPromptTokens = normalizeTokenCount(budget.systemPromptTokens)
  const contextSnapshotTokens = normalizeTokenCount(budget.contextSnapshotTokens)
  const memoryPromptTokens = normalizeTokenCount(budget.memoryPromptTokens)
  const historyDigestTokens = normalizeTokenCount(budget.historyDigestTokens)
  const recentMessageTokens = normalizeTokenCount(budget.recentMessageTokens)
  const safetyBufferTokens = normalizeTokenCount(budget.safetyBufferTokens)
  const availableInputTokens = normalizeTokenCount(budget.availableInputTokens)
  const recentMessageBudgetTokens = normalizeTokenCount(budget.recentMessageBudgetTokens)
  const overflowTokens = normalizeTokenCount(budget.overflowTokens)
  const inputLimit = Math.max(0, contextWindow - reservedOutputTokens)
  const usedInputTokens = systemPromptTokens
    + contextSnapshotTokens
    + memoryPromptTokens
    + historyDigestTokens
    + recentMessageTokens
    + safetyBufferTokens

  return {
    usedPercent: Math.min(100, Math.max(0, budget.budgetUsedRatio * 100)),
    fillPercent: resolveBudgetFillPercent(budget.budgetUsedRatio),
    usedText: `${formatChatTokenCount(usedInputTokens)} / ${formatChatTokenCount(inputLimit)} tokens`,
    sourceText: formatBudgetSource(budget.estimationSource),
    rows: [
      { label: translate('chat.usage.contextWindow'), value: `${formatChatTokenCount(contextWindow)} tokens` },
      { label: translate('chat.usage.reservedOutput'), value: `${formatChatTokenCount(reservedOutputTokens)} tokens` },
      { label: translate('chat.usage.systemPrompt'), value: `${formatChatTokenCount(systemPromptTokens)} tokens` },
      { label: translate('chat.usage.contextSnapshots'), value: `${formatChatTokenCount(contextSnapshotTokens)} tokens` },
      { label: translate('chat.usage.longTermMemory'), value: `${formatChatTokenCount(memoryPromptTokens)} tokens` },
      { label: translate('chat.usage.historyDigest'), value: `${formatChatTokenCount(historyDigestTokens)} tokens` },
      { label: translate('chat.usage.recentMessages'), value: `${formatChatTokenCount(recentMessageTokens)} tokens` },
      { label: translate('chat.usage.safetyBuffer'), value: `${formatChatTokenCount(safetyBufferTokens)} tokens` },
      { label: translate('chat.usage.availableInput'), value: `${formatChatTokenCount(availableInputTokens)} tokens` },
      { label: translate('chat.usage.messageBudget'), value: `${formatChatTokenCount(recentMessageBudgetTokens)} tokens` },
      overflowTokens > 0
        ? {
            label: translate('chat.usage.overflow'),
            value: `${formatChatTokenCount(overflowTokens)} tokens`,
            tone: 'warning',
          }
        : null,
    ].filter(Boolean) as ChatUsageDetailRow[],
  }
}

function normalizeTokenCount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function formatUsageSource(source: AssistantUsage['usageSource']) {
  switch (source) {
    case 'provider':
      return translate('chat.usage.providerReturned')
    case 'mixed':
      return translate('chat.usage.providerEstimated')
    case 'estimated':
      return translate('chat.usage.localEstimated')
  }
}

function formatBudgetSource(source: ContextBudget['estimationSource']) {
  switch (source) {
    case 'provider-tokenizer':
      return translate('chat.usage.providerTokenizer')
    case 'tiktoken-compatible':
      return translate('chat.usage.compatibleTokenizer')
    case 'heuristic':
      return translate('chat.usage.heuristicEstimated')
  }
}

function formatExactCount(value: number) {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.round(value)))
}

function createAggregateRow(
  label: string,
  usage: ChatTokenUsageAggregate,
  tone?: ChatUsageDetailRow['tone'],
): ChatUsageDetailRow {
  return {
    label,
    value: translate('chat.usage.aggregateValue', {
      count: formatExactCount(usage.generationCount),
      tokens: formatChatTokenCount(usage.totalTokens),
    }),
    tone,
  }
}

function createEmptyUsageAggregate(): ChatTokenUsageAggregate {
  return {
    generationCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
}

function subtractUsage(
  current: ChatTokenUsageAggregate,
  baseline: ChatTokenUsageAggregate,
): ChatTokenUsageAggregate {
  return {
    generationCount: Math.max(0, current.generationCount - baseline.generationCount),
    inputTokens: Math.max(0, current.inputTokens - baseline.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - baseline.outputTokens),
    reasoningTokens: Math.max(0, current.reasoningTokens - baseline.reasoningTokens),
    totalTokens: Math.max(0, current.totalTokens - baseline.totalTokens),
  }
}

function resolveBudgetFillPercent(ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return 0
  }

  return Math.min(100, Math.max(3.5, ratio * 100))
}
