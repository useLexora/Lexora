import type { AgentSkillConnectorType } from '@haohaoxue/lexora-contracts/agent'
import type { ToolCall, ToolCallChunk } from '@langchain/core/messages'
import type { AgentChatModelResponse } from './chat-model'
import { createAgentInternalToolProtocolStripper } from '@haohaoxue/lexora-shared/agent'
import { AIMessageChunk } from '@langchain/core/messages'
import {
  readChatModelResponseReasoning,
  readChatModelResponseText,
} from './response-text'

export type AgentModelStreamPart
  = | { type: 'reasoning.delta', text: string, raw?: unknown }
    | { type: 'text.delta', text: string, raw?: unknown }
    | { type: 'tool.call.started', toolCallId: string, actionName?: string, raw?: unknown }
    | { type: 'tool.call.args.delta', toolCallId: string, text: string, raw?: unknown }
    | { type: 'tool.call.completed', toolCallId: string, actionName?: string, raw?: unknown }
    | {
      type: 'tool.execution.started'
      toolCallId: string
      skillKey?: string
      actionName?: string
      connectorType?: AgentSkillConnectorType
      args?: unknown
      argsText?: string
      raw?: unknown
    }
    | {
      type: 'tool.execution.completed'
      toolCallId: string
      skillKey?: string
      actionName?: string
      connectorType?: AgentSkillConnectorType
      status: 'success' | 'error' | 'requires_action'
      output?: unknown
      outputText?: string
      durationMs?: number
      raw?: unknown
    }
    | {
      type: 'tool.execution.failed'
      toolCallId: string
      skillKey?: string
      actionName?: string
      connectorType?: AgentSkillConnectorType
      message: string
      durationMs?: number
      raw?: unknown
    }

export interface ConsumeChatModelTextStreamOptions {
  onStreamPart?: (part: AgentModelStreamPart) => Promise<void> | void
  onTextDelta?: (text: string) => Promise<void> | void
  now?: () => number
}

export interface AgentModelTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
}

export interface AgentModelTextStreamResult {
  text: string
  providerUsage: AgentModelTokenUsage | null
  toolCalls: ToolCall[]
  suppressedToolCallBlockCount: number
  firstTokenLatencyMs?: number
  elapsedMs: number
}

export async function consumeChatModelTextStream(
  stream: AsyncIterable<AgentChatModelResponse>,
  options: ConsumeChatModelTextStreamOptions = {},
): Promise<AgentModelTextStreamResult> {
  let responseText = ''
  let providerUsage: AgentModelTokenUsage | null = null
  let firstTokenAt: number | null = null
  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  const tagParser = createReasoningTagStreamParser()
  const textToolCallBlockStripper = createAgentInternalToolProtocolStripper()
  const reasoningToolCallBlockStripper = createAgentInternalToolProtocolStripper()
  const normalizeReasoningDelta = createLeadingBlankLineNormalizer()
  const normalizeTextDelta = createLeadingBlankLineNormalizer()
  let responseChunk: AIMessageChunk | null = null
  const toolCallStreamState = createToolCallStreamState()
  let suppressedToolCallBlockCount = 0

  function recordSuppressedToolCallBlocks(count: number): void {
    suppressedToolCallBlockCount += count
  }

  for await (const chunk of stream) {
    if (AIMessageChunk.isInstance(chunk)) {
      responseChunk = responseChunk ? responseChunk.concat(chunk) : chunk
      await emitToolCallChunkParts(chunk.tool_call_chunks ?? [], toolCallStreamState, options, chunk, () => {
        firstTokenAt ??= now()
      })
    }

    providerUsage = mergeTokenUsage(providerUsage, readProviderUsage(chunk))
    const reasoning = readChatModelResponseReasoning(chunk)
    const hasStructuredReasoning = Boolean(reasoning)
    if (reasoning) {
      const normalizedReasoning = normalizeReasoningDelta(reasoning)
      const strippedReasoning = reasoningToolCallBlockStripper.write(normalizedReasoning)
      recordSuppressedToolCallBlocks(strippedReasoning.suppressedBlockCount)
      await emitReasoningTextDeltas({
        deltas: strippedReasoning.textDeltas,
        raw: chunk,
        options,
        markFirstToken: () => {
          firstTokenAt ??= now()
        },
      })
    }

    const text = readChatModelResponseText(chunk)
    if (!text) {
      continue
    }

    for (const part of tagParser.write(text)) {
      if (part.type === 'reasoning.delta' && hasStructuredReasoning) {
        continue
      }

      const normalizedText = part.type === 'text.delta'
        ? normalizeTextDelta(part.text)
        : normalizeReasoningDelta(part.text)

      if (part.type === 'text.delta') {
        await consumeTextDelta({
          text: normalizedText,
          stripper: textToolCallBlockStripper,
          appendText(delta) {
            responseText += delta
          },
          emit: async delta => await emitPart({ ...part, text: delta, raw: chunk }, options, () => {
            firstTokenAt ??= now()
          }),
          recordSuppressedToolCallBlocks,
        })
        continue
      }

      if (part.type === 'reasoning.delta') {
        const strippedReasoning = reasoningToolCallBlockStripper.write(normalizedText)
        recordSuppressedToolCallBlocks(strippedReasoning.suppressedBlockCount)
        await emitReasoningTextDeltas({
          deltas: strippedReasoning.textDeltas,
          raw: chunk,
          options,
          markFirstToken: () => {
            firstTokenAt ??= now()
          },
        })
        continue
      }
    }
  }

  for (const part of tagParser.flush()) {
    const normalizedText = part.type === 'text.delta'
      ? normalizeTextDelta(part.text)
      : normalizeReasoningDelta(part.text)

    if (part.type === 'text.delta') {
      await consumeTextDelta({
        text: normalizedText,
        stripper: textToolCallBlockStripper,
        appendText(delta) {
          responseText += delta
        },
        emit: async delta => await emitPart({ ...part, text: delta }, options, () => {
          firstTokenAt ??= now()
        }),
        recordSuppressedToolCallBlocks,
      })
      continue
    }

    if (part.type === 'reasoning.delta') {
      const strippedReasoning = reasoningToolCallBlockStripper.write(normalizedText)
      recordSuppressedToolCallBlocks(strippedReasoning.suppressedBlockCount)
      await emitReasoningTextDeltas({
        deltas: strippedReasoning.textDeltas,
        options,
        markFirstToken: () => {
          firstTokenAt ??= now()
        },
      })
      continue
    }
  }

  await emitTextToolCallStripResult({
    result: textToolCallBlockStripper.flush(),
    appendText(delta) {
      responseText += delta
    },
    emit: async delta => await emitPart({ type: 'text.delta', text: delta }, options, () => {
      firstTokenAt ??= now()
    }),
    recordSuppressedToolCallBlocks,
  })

  const strippedReasoning = reasoningToolCallBlockStripper.flush()
  recordSuppressedToolCallBlocks(strippedReasoning.suppressedBlockCount)
  await emitReasoningTextDeltas({
    deltas: strippedReasoning.textDeltas,
    options,
    markFirstToken: () => {
      firstTokenAt ??= now()
    },
  })

  await emitCompletedToolCallParts(toolCallStreamState, options)

  const completedAt = now()

  return {
    text: responseText,
    providerUsage,
    toolCalls: normalizeToolCalls(responseChunk?.tool_calls ?? []),
    suppressedToolCallBlockCount,
    firstTokenLatencyMs: firstTokenAt === null ? undefined : Math.max(0, Math.trunc(firstTokenAt - startedAt)),
    elapsedMs: Math.max(0, Math.trunc(completedAt - startedAt)),
  }
}

async function emitReasoningTextDeltas(input: {
  deltas: string[]
  raw?: unknown
  options: ConsumeChatModelTextStreamOptions
  markFirstToken: () => void
}): Promise<void> {
  for (const text of input.deltas) {
    await emitPart({
      type: 'reasoning.delta',
      text,
      raw: input.raw,
    }, input.options, input.markFirstToken)
  }
}

interface ToolCallStreamItem {
  toolCallId?: string
  actionName?: string
  argsText: string
  pendingArgDeltas: string[]
  started: boolean
  completed: boolean
}

interface ToolCallStreamState {
  items: Map<string, ToolCallStreamItem>
}

function createToolCallStreamState(): ToolCallStreamState {
  return {
    items: new Map(),
  }
}

async function emitToolCallChunkParts(
  chunks: ToolCallChunk[],
  state: ToolCallStreamState,
  options: ConsumeChatModelTextStreamOptions,
  raw: unknown,
  markFirstToken: () => void,
): Promise<void> {
  for (const [index, chunk] of chunks.entries()) {
    const key = getToolCallChunkKey(chunk, index)
    const fallbackKey = getToolCallChunkPositionKey(index)
    const item = state.items.get(key) ?? state.items.get(fallbackKey) ?? {
      toolCallId: undefined,
      actionName: undefined,
      argsText: '',
      pendingArgDeltas: [],
      started: false,
      completed: false,
    }

    item.toolCallId = mergeOptionalChunkString(item.toolCallId, chunk.id)
    item.actionName = mergeOptionalChunkString(item.actionName, chunk.name)

    if (chunk.args) {
      item.argsText += chunk.args
    }

    if (!item.toolCallId) {
      if (chunk.args) {
        item.pendingArgDeltas.push(chunk.args)
      }
      state.items.set(key, item)
      continue
    }

    if (!item.started) {
      item.started = true
      await emitPart({
        type: 'tool.call.started',
        toolCallId: item.toolCallId,
        actionName: item.actionName,
        raw,
      }, options, markFirstToken)

      for (const pendingArgDelta of item.pendingArgDeltas) {
        await emitPart({
          type: 'tool.call.args.delta',
          toolCallId: item.toolCallId,
          text: pendingArgDelta,
          raw,
        }, options, markFirstToken)
      }
      item.pendingArgDeltas = []
    }

    if (chunk.args) {
      await emitPart({
        type: 'tool.call.args.delta',
        toolCallId: item.toolCallId,
        text: chunk.args,
        raw,
      }, options, markFirstToken)
    }

    state.items.set(key, item)
    if (fallbackKey !== key) {
      state.items.delete(fallbackKey)
    }
  }
}

async function emitCompletedToolCallParts(
  state: ToolCallStreamState,
  options: ConsumeChatModelTextStreamOptions,
): Promise<void> {
  for (const item of state.items.values()) {
    if (!item.toolCallId || !item.started || item.completed) {
      continue
    }

    item.completed = true
    await emitPart({
      type: 'tool.call.completed',
      toolCallId: item.toolCallId,
      actionName: item.actionName,
    }, options, () => {})
  }
}

function getToolCallChunkKey(chunk: ToolCallChunk, index: number): string {
  if (typeof chunk.index === 'number') {
    return `index:${chunk.index}`
  }

  if (chunk.id) {
    return `id:${chunk.id}`
  }

  return `position:${index}`
}

function getToolCallChunkPositionKey(index: number): string {
  return `position:${index}`
}

function mergeOptionalChunkString(current: string | undefined, fragment: string | undefined): string | undefined {
  if (!fragment) {
    return current
  }

  return mergeChunkString(current ?? '', fragment)
}

function mergeChunkString(current: string, fragment: string | undefined): string {
  if (!fragment) {
    return current
  }

  if (!current) {
    return fragment
  }

  if (current.endsWith(fragment)) {
    return current
  }

  if (fragment.startsWith(current)) {
    return fragment
  }

  return `${current}${fragment}`
}

function normalizeToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.filter((toolCall): toolCall is ToolCall & { id: string } =>
    typeof toolCall.id === 'string'
    && toolCall.id.trim().length > 0
    && typeof toolCall.name === 'string'
    && toolCall.name.trim().length > 0,
  )
}

type TextToolCallBlockStripper = ReturnType<typeof createAgentInternalToolProtocolStripper>
type TextToolCallStripResult = ReturnType<TextToolCallBlockStripper['write']>

async function consumeTextDelta(input: {
  text: string
  stripper: TextToolCallBlockStripper
  appendText: (text: string) => void
  emit: (text: string) => Promise<void>
  recordSuppressedToolCallBlocks: (count: number) => void
}): Promise<void> {
  await emitTextToolCallStripResult({
    result: input.stripper.write(input.text),
    appendText: input.appendText,
    emit: input.emit,
    recordSuppressedToolCallBlocks: input.recordSuppressedToolCallBlocks,
  })
}

async function emitTextToolCallStripResult(input: {
  result: TextToolCallStripResult
  appendText: (text: string) => void
  emit: (text: string) => Promise<void>
  recordSuppressedToolCallBlocks: (count: number) => void
}): Promise<void> {
  input.recordSuppressedToolCallBlocks(input.result.suppressedBlockCount)
  for (const textDelta of input.result.textDeltas) {
    input.appendText(textDelta)
    await input.emit(textDelta)
  }
}

async function emitPart(
  part: AgentModelStreamPart,
  options: ConsumeChatModelTextStreamOptions,
  markFirstToken: () => void,
): Promise<void> {
  if ('text' in part && part.text === '') {
    return
  }

  markFirstToken()
  await options.onStreamPart?.(part)

  if (part.type === 'text.delta') {
    await options.onTextDelta?.(part.text)
  }
}

function readProviderUsage(chunk: AgentChatModelResponse): AgentModelTokenUsage | null {
  return readLangChainUsageMetadata(chunk.usage_metadata)
    ?? readProviderResponseUsage(chunk.response_metadata)
}

function readLangChainUsageMetadata(value: unknown): AgentModelTokenUsage | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const usage = value as Record<string, unknown>
  return normalizeUsage({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    reasoningTokens: readNestedNumber(usage.output_token_details, 'reasoning'),
  })
}

function readProviderResponseUsage(value: unknown): AgentModelTokenUsage | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const metadata = value as Record<string, unknown>
  const usage = metadata.usage
  if (!usage || typeof usage !== 'object') {
    return null
  }

  const usageRecord = usage as Record<string, unknown>
  return normalizeUsage({
    inputTokens: usageRecord.input_tokens ?? usageRecord.prompt_tokens,
    outputTokens: usageRecord.output_tokens ?? usageRecord.completion_tokens,
    totalTokens: usageRecord.total_tokens,
    reasoningTokens: readNestedNumber(usageRecord.output_tokens_details, 'reasoning_tokens')
      ?? readNestedNumber(usageRecord.completion_tokens_details, 'reasoning_tokens'),
  })
}

function normalizeUsage(input: {
  inputTokens?: unknown
  outputTokens?: unknown
  totalTokens?: unknown
  reasoningTokens?: unknown
}): AgentModelTokenUsage | null {
  const usage = {
    inputTokens: readNonNegativeInteger(input.inputTokens),
    outputTokens: readNonNegativeInteger(input.outputTokens),
    totalTokens: readNonNegativeInteger(input.totalTokens),
    reasoningTokens: readNonNegativeInteger(input.reasoningTokens),
  }

  if (
    usage.inputTokens === undefined
    && usage.outputTokens === undefined
    && usage.totalTokens === undefined
    && usage.reasoningTokens === undefined
  ) {
    return null
  }

  return usage
}

function mergeTokenUsage(
  current: AgentModelTokenUsage | null,
  next: AgentModelTokenUsage | null,
): AgentModelTokenUsage | null {
  if (!next) {
    return current
  }

  if (!current) {
    return next
  }

  const currentTotal = current.totalTokens ?? (current.inputTokens ?? 0) + (current.outputTokens ?? 0)
  const nextTotal = next.totalTokens ?? (next.inputTokens ?? 0) + (next.outputTokens ?? 0)
  return nextTotal >= currentTotal ? { ...current, ...next } : current
}

function readNestedNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  return readNonNegativeInteger((value as Record<string, unknown>)[key])
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined
}

type ReasoningTagPart = Extract<AgentModelStreamPart, { type: 'reasoning.delta' | 'text.delta' }>

const OPEN_REASONING_TAGS = ['<think>', '<thinking>', '<reasoning>'] as const
const CLOSE_REASONING_TAGS = ['</think>', '</thinking>', '</reasoning>'] as const

interface ReasoningTagMatch {
  index: number
  tag: string
}

interface ReasoningTagStreamParser {
  write: (text: string) => ReasoningTagPart[]
  flush: () => ReasoningTagPart[]
}

function createReasoningTagStreamParser(): ReasoningTagStreamParser {
  let mode: 'text' | 'reasoning' = 'text'
  let buffer = ''

  return {
    write(text) {
      buffer += text
      return drainBuffer(false)
    },

    flush() {
      return drainBuffer(true)
    },
  }

  function drainBuffer(flush: boolean): ReasoningTagPart[] {
    const parts: ReasoningTagPart[] = []

    while (buffer) {
      if (mode === 'text') {
        const openTag = findFirstTag(buffer, OPEN_REASONING_TAGS)
        if (openTag) {
          pushPart(parts, 'text.delta', buffer.slice(0, openTag.index))
          buffer = buffer.slice(openTag.index + openTag.tag.length)
          mode = 'reasoning'
          continue
        }

        const keepLength = flush ? 0 : getPartialTagSuffixLength(buffer, OPEN_REASONING_TAGS)
        pushPart(parts, 'text.delta', buffer.slice(0, buffer.length - keepLength))
        buffer = buffer.slice(buffer.length - keepLength)
        break
      }

      const closeTag = findFirstTag(buffer, CLOSE_REASONING_TAGS)
      if (closeTag) {
        pushPart(parts, 'reasoning.delta', buffer.slice(0, closeTag.index))
        buffer = buffer.slice(closeTag.index + closeTag.tag.length)
        mode = 'text'
        continue
      }

      const keepLength = flush ? 0 : getPartialTagSuffixLength(buffer, CLOSE_REASONING_TAGS)
      pushPart(parts, 'reasoning.delta', buffer.slice(0, buffer.length - keepLength))
      buffer = buffer.slice(buffer.length - keepLength)
      break
    }

    return parts
  }
}

function pushPart(
  parts: ReasoningTagPart[],
  type: ReasoningTagPart['type'],
  text: string,
): void {
  if (!text) {
    return
  }

  parts.push({ type, text })
}

const LEADING_BLANK_LINE_SEPARATOR_PATTERN = /^[\t ]*(?:\r?\n[\t ]*)+/
const HORIZONTAL_WHITESPACE_PATTERN = /^[\t ]*$/

function createLeadingBlankLineNormalizer(): (text: string) => string {
  let hasEmittedText = false
  let pendingLeadingWhitespace = ''

  return (text) => {
    if (hasEmittedText) {
      return text
    }

    const candidate = pendingLeadingWhitespace + text
    pendingLeadingWhitespace = ''

    const withoutLeadingBlankLines = candidate.replace(LEADING_BLANK_LINE_SEPARATOR_PATTERN, '')
    if (withoutLeadingBlankLines !== candidate) {
      hasEmittedText = withoutLeadingBlankLines !== ''
      return withoutLeadingBlankLines
    }

    if (HORIZONTAL_WHITESPACE_PATTERN.test(candidate)) {
      pendingLeadingWhitespace = candidate
      return ''
    }

    hasEmittedText = true
    return candidate
  }
}

function findFirstTag(text: string, tags: readonly string[]): ReasoningTagMatch | null {
  const normalizedText = text.toLowerCase()
  let bestMatch: ReasoningTagMatch | null = null

  for (const tag of tags) {
    const index = normalizedText.indexOf(tag)
    if (index < 0) {
      continue
    }

    if (!bestMatch || index < bestMatch.index) {
      bestMatch = { index, tag }
    }
  }

  return bestMatch
}

function getPartialTagSuffixLength(text: string, tags: readonly string[]): number {
  const normalizedText = text.toLowerCase()
  let suffixLength = 0

  for (const tag of tags) {
    const maxLength = Math.min(tag.length - 1, normalizedText.length)
    for (let length = 1; length <= maxLength; length += 1) {
      if (tag.startsWith(normalizedText.slice(-length))) {
        suffixLength = Math.max(suffixLength, length)
      }
    }
  }

  return suffixLength
}
