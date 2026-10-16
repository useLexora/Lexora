import type { MaybeRefOrGetter } from 'vue'
import type { ChatMarkdownBlock, ChatMarkdownBlocksResult, ChatMarkdownRenderPhase } from './typing'
import { onScopeDispose, shallowRef, toValue, watch } from 'vue'
import { getChatStreamingProbe } from '@/composables/chat/utils/chat-streaming-probe'
import {
  renderChatMarkdown,
  renderStreamingCodeBlock,
  renderStreamingMathBlock,
  renderStreamingTableBlock,
  renderStreamingTextBlock,
} from './markdownRenderer'

const STREAMING_MARKDOWN_COALESCE_MS = 48
const STREAMING_TEXT_REVEAL_GRAPHEME_MS = 16
const STREAMING_TEXT_REVEAL_FRAME_FALLBACK_MS = 16

interface MarkdownFenceMarker {
  marker: '`' | '~'
  length: number
}

interface StreamingMarkdownSplitBlock {
  kind: ChatMarkdownBlock['kind']
  source: string
}

interface StreamingMarkdownBlockRenderOptions {
  getDisplaySource?: (
    block: StreamingMarkdownSplitBlock,
    index: number,
    blocks: readonly StreamingMarkdownSplitBlock[],
  ) => string
}

interface StreamingMarkdownRevealFrame {
  id: number | ReturnType<typeof setTimeout>
  kind: 'raf' | 'timeout'
}

interface StreamingMarkdownRevealState {
  identity: string
  source: string
  visibleSource: string
  input: StreamingMarkdownRenderInput
  frame: StreamingMarkdownRevealFrame | null
  lastTick: number
}

type StreamingMarkdownPartialDisplayKind = 'code' | 'text'

type StreamingMarkdownRevealTargetKind = 'code' | 'markdown'

interface GraphemeSlice {
  text: string
  graphemeCount: number
}

interface GraphemeSegment {
  segment: string
}

interface GraphemeSegmenter {
  segment: (input: string) => Iterable<GraphemeSegment>
}

const STREAMING_TEXT_REVEAL_GRAPHEME_SEGMENTER = createGraphemeSegmenter()

export interface StreamingMarkdownRenderInput {
  messageId: string
  partId: string
  source: string
  phase: ChatMarkdownRenderPhase
}

export interface UseStreamingMarkdownBlocksOptions {
  messageId: MaybeRefOrGetter<string>
  partId: MaybeRefOrGetter<string>
  source: MaybeRefOrGetter<string>
  phase: MaybeRefOrGetter<ChatMarkdownRenderPhase>
}

export function useStreamingMarkdownBlocks(options: UseStreamingMarkdownBlocksOptions) {
  const cache = createStreamingMarkdownBlockCache()
  const blocks = shallowRef<ChatMarkdownBlock[]>([])
  let latestRenderedInput: StreamingMarkdownRenderInput | null = null
  let pendingInput: StreamingMarkdownRenderInput | null = null
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let revealState: StreamingMarkdownRevealState | null = null

  function clearPendingTimer(): void {
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
  }

  function clearRevealFrame(): void {
    if (revealState?.frame) {
      cancelRevealFrame(revealState.frame)
      revealState.frame = null
    }
  }

  function renderNow(input: StreamingMarkdownRenderInput): void {
    clearPendingTimer()
    pendingInput = null
    const probe = getChatStreamingProbe()
    const renderOptions = createRevealRenderOptions(input)

    if (!probe) {
      const result = cache.render(input, renderOptions)
      blocks.value = result.blocks
      latestRenderedInput = input
      scheduleRevealTick()
      return
    }

    const startedAt = performance.now()
    const result = cache.render(input, renderOptions)
    const endedAt = performance.now()

    probe.recordMarkdownBlocksRender?.({
      messageId: input.messageId,
      partId: input.partId,
      phase: input.phase,
      sourceLength: input.source.length,
      blockCount: result.blocks.length,
      durationMs: endedAt - startedAt,
      startedAt,
      endedAt,
    })

    blocks.value = result.blocks
    latestRenderedInput = input
    scheduleRevealTick()
  }

  function flushPendingInput(): void {
    const input = pendingInput
    pendingInput = null
    pendingTimer = null

    if (input) {
      renderNow(input)
    }
  }

  function scheduleRender(input: StreamingMarkdownRenderInput): void {
    pendingInput = input

    if (pendingTimer) {
      const probe = getChatStreamingProbe()
      probe?.recordCoalesce?.({
        kind: 'reuse-pending-timer',
        phase: input.phase,
        sourceLength: input.source.length,
      })
      return
    }

    const delayMs = resolveStreamingMarkdownCoalesceMs()
    const probe = getChatStreamingProbe()
    probe?.recordCoalesce?.({
      kind: 'schedule',
      delayMs,
      phase: input.phase,
      sourceLength: input.source.length,
    })
    pendingTimer = setTimeout(flushPendingInput, delayMs)
  }

  watch(() => ({
    messageId: toValue(options.messageId),
    partId: toValue(options.partId),
    source: toValue(options.source),
    phase: toValue(options.phase),
  }), (input) => {
    if (shouldRenderStreamingMarkdownImmediately(latestRenderedInput, input)) {
      renderNow(input)
      return
    }

    scheduleRender(input)
  }, {
    flush: 'sync',
    immediate: true,
  })

  onScopeDispose(() => {
    clearPendingTimer()
    clearRevealFrame()
  })

  function createRevealRenderOptions(input: StreamingMarkdownRenderInput): StreamingMarkdownBlockRenderOptions | undefined {
    if (input.phase !== 'streaming' && input.phase !== 'final') {
      clearRevealFrame()
      revealState = null
      return undefined
    }

    const splitBlocks = splitMarkdownBlocks(input.source, input.phase)
    const revealTarget = resolveRevealTarget(input, splitBlocks)

    if (!revealTarget) {
      clearRevealFrame()
      revealState = null
      return undefined
    }

    const previousReveal = revealState
    const shouldContinueReveal = Boolean(previousReveal
      && previousReveal.identity === revealTarget.identity
      && revealTarget.source.startsWith(previousReveal.source))

    if (!shouldContinueReveal) {
      clearRevealFrame()
    }

    const visibleSource = shouldContinueReveal && previousReveal
      ? clampRevealVisibleSource(previousReveal.visibleSource, revealTarget.source)
      : resolveInitialRevealVisibleSource(input, revealTarget)

    if (input.phase === 'final' && visibleSource.length >= revealTarget.source.length) {
      clearRevealFrame()
      revealState = null
      return undefined
    }

    revealState = {
      frame: shouldContinueReveal && previousReveal ? previousReveal.frame : null,
      identity: revealTarget.identity,
      input,
      lastTick: shouldContinueReveal && previousReveal ? previousReveal.lastTick : 0,
      source: revealTarget.source,
      visibleSource,
    }

    return {
      getDisplaySource: (block, index, blocks) => {
        const state = revealState
        if (!state || index !== blocks.length - 1 || block.source !== state.source) {
          return block.source
        }

        return state.visibleSource
      },
    }
  }

  function resolveInitialRevealVisibleSource(
    input: StreamingMarkdownRenderInput,
    revealTarget: { identity: string, source: string },
  ): string {
    const previousInput = latestRenderedInput

    if (!previousInput) {
      return input.phase === 'streaming' ? '' : revealTarget.source
    }

    if (
      previousInput.messageId !== input.messageId
      || previousInput.partId !== input.partId
      || !input.source.startsWith(previousInput.source)
    ) {
      return revealTarget.source
    }

    const previousTarget = resolveRevealTarget(
      previousInput,
      splitMarkdownBlocks(previousInput.source, previousInput.phase),
    )

    if (
      previousTarget
      && previousTarget.identity === revealTarget.identity
      && revealTarget.source.startsWith(previousTarget.source)
    ) {
      return previousTarget.source
    }

    return ''
  }

  function scheduleRevealTick(): void {
    if (!revealState || revealState.visibleSource.length >= revealState.source.length || revealState.frame) {
      return
    }

    revealState.frame = requestRevealFrame(advanceReveal)
  }

  function advanceReveal(timestamp: number): void {
    const state = revealState
    if (!state) {
      return
    }

    state.frame = null

    if (state.visibleSource.length >= state.source.length) {
      completeRevealIfNeeded(state)
      return
    }

    if (!state.lastTick) {
      state.lastTick = timestamp - STREAMING_TEXT_REVEAL_GRAPHEME_MS
    }

    if (timestamp - state.lastTick < STREAMING_TEXT_REVEAL_GRAPHEME_MS) {
      scheduleRevealTick()
      return
    }

    state.lastTick = timestamp

    const pendingSource = state.source.slice(state.visibleSource.length)
    const nextSlice = takeGraphemes(pendingSource, 1)

    if (!nextSlice.text) {
      scheduleRevealTick()
      return
    }

    state.visibleSource += nextSlice.text

    blocks.value = cache.render(state.input, {
      getDisplaySource: (block, index, splitBlocks) => {
        if (!revealState || index !== splitBlocks.length - 1 || block.source !== revealState.source) {
          return block.source
        }

        return revealState.visibleSource
      },
    }).blocks

    if (state.visibleSource.length >= state.source.length) {
      completeRevealIfNeeded(state)
    }

    scheduleRevealTick()
  }

  function completeRevealIfNeeded(state: StreamingMarkdownRevealState): void {
    state.lastTick = 0

    if (state.input.phase === 'final' && revealState === state) {
      revealState = null
    }
  }

  return {
    blocks,
  }
}

function resolveStreamingMarkdownCoalesceMs(): number {
  const override = getChatStreamingProbe()?.coalesceMs

  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return override
  }

  return STREAMING_MARKDOWN_COALESCE_MS
}

export function createStreamingMarkdownBlockCache() {
  const blocksByScope = new Map<string, Map<string, ChatMarkdownBlock>>()

  return {
    render(input: StreamingMarkdownRenderInput, options: StreamingMarkdownBlockRenderOptions = {}): ChatMarkdownBlocksResult {
      const scopeKey = `${input.messageId}:${input.partId}`
      const previousBlocks = blocksByScope.get(scopeKey) ?? new Map<string, ChatMarkdownBlock>()
      const nextBlocks = new Map<string, ChatMarkdownBlock>()
      const splitBlocks = splitMarkdownBlocks(input.source, input.phase)
      const blocks = splitBlocks.map((block, index) => {
        const blockKey = `${index}:${block.kind}:${getMarkdownBlockPhaseKey(block, input.phase)}:${block.source}`
        const displaySource = options.getDisplaySource?.(block, index, splitBlocks) ?? block.source
        const renderKey = `${blockKey}:${displaySource}`
        const previousBlock = previousBlocks.get(renderKey)

        if (previousBlock) {
          nextBlocks.set(renderKey, previousBlock)
          return previousBlock
        }

        const nextBlock: ChatMarkdownBlock = {
          key: blockKey,
          kind: block.kind,
          source: block.source,
          html: renderMarkdownBlock({
            kind: block.kind,
            source: displaySource,
          }, input.phase, resolvePartialDisplayKind(block, displaySource)),
        }
        nextBlocks.set(renderKey, nextBlock)
        return nextBlock
      })

      blocksByScope.set(scopeKey, nextBlocks)

      return {
        blocks,
      }
    },
  }
}

function renderMarkdownBlock(
  block: StreamingMarkdownSplitBlock,
  phase: ChatMarkdownRenderPhase,
  partialDisplayKind: StreamingMarkdownPartialDisplayKind | null = null,
): string {
  if (partialDisplayKind === 'code') {
    return renderStreamingCodeBlock(block.source)
  }

  if (block.kind === 'incomplete-code') {
    return renderStreamingCodeBlock(block.source)
  }

  if (block.kind === 'incomplete-table') {
    return renderStreamingTableBlock(block.source)
  }

  if (block.kind === 'incomplete-math') {
    return renderStreamingMathBlock(block.source)
  }

  if (partialDisplayKind === 'text') {
    return renderStreamingTextBlock(block.source)
  }

  return renderChatMarkdown(block.source, { phase })
}

function resolvePartialDisplayKind(
  block: StreamingMarkdownSplitBlock,
  displaySource: string,
): StreamingMarkdownPartialDisplayKind | null {
  if (displaySource === block.source) {
    return null
  }

  if (block.kind === 'incomplete-code' || hasFenceMarker(block.source)) {
    return 'code'
  }

  return 'text'
}

function shouldRenderStreamingMarkdownImmediately(
  previous: StreamingMarkdownRenderInput | null,
  next: StreamingMarkdownRenderInput,
): boolean {
  if (!previous) {
    return true
  }

  if (next.phase === 'final' || next.phase !== previous.phase) {
    return true
  }

  if (next.messageId !== previous.messageId || next.partId !== previous.partId) {
    return true
  }

  if (!next.source.startsWith(previous.source)) {
    return true
  }

  return hasStreamingMarkdownStructureBoundary(next.source.slice(previous.source.length), next.source)
}

function hasStreamingMarkdownStructureBoundary(appendedSource: string, nextSource: string): boolean {
  if (appendedSource.includes('\n')) {
    return true
  }

  const currentLine = nextSource.slice(nextSource.lastIndexOf('\n') + 1)
  return /^#{1,6}\s/.test(currentLine)
    || /^[-*+]\s/.test(currentLine)
    || /^\d+\.\s/.test(currentLine)
    || /^>\s/.test(currentLine)
    || Boolean(getMarkdownFenceMarker(currentLine))
    || /^\|/.test(currentLine)
}

function splitMarkdownBlocks(source: string, phase: ChatMarkdownRenderPhase): StreamingMarkdownSplitBlock[] {
  if (!source.trim()) {
    return []
  }

  const lines = source.split('\n')
  const blocks: StreamingMarkdownSplitBlock[] = []
  let start = 0
  let index = 0
  let activeFence: MarkdownFenceMarker | null = null

  while (index < lines.length) {
    const fenceMarker = getMarkdownFenceMarker(lines[index] ?? '')
    if (fenceMarker) {
      if (!activeFence) {
        activeFence = fenceMarker
      }
      else if (fenceMarker.marker === activeFence.marker && fenceMarker.length >= activeFence.length) {
        activeFence = null
      }
    }

    if (!activeFence && lines[index] === '') {
      pushMarkdownBlock(blocks, lines.slice(start, index).join('\n'), phase)
      while (lines[index] === '') {
        index += 1
      }
      start = index
      continue
    }

    index += 1
  }

  const tail = lines.slice(start).join('\n')
  if (activeFence && phase === 'streaming') {
    blocks.push({
      kind: 'incomplete-code',
      source: tail,
    })
  }
  else {
    pushMarkdownBlock(blocks, tail, phase)
  }

  return blocks
}

function getMarkdownBlockPhaseKey(block: StreamingMarkdownSplitBlock, phase: ChatMarkdownRenderPhase): string {
  if (block.kind === 'incomplete-code' || hasFenceMarker(block.source)) {
    return phase
  }

  return 'stable'
}

function hasFenceMarker(source: string): boolean {
  return source.split('\n').some(line => getMarkdownFenceMarker(line))
}

function getMarkdownFenceMarker(line: string): MarkdownFenceMarker | null {
  const normalized = normalizeMarkdownFenceLine(line)
  const match = normalized.match(/^(`{3,}|~{3,})/)
  const marker = match?.[1]

  if (!marker) {
    return null
  }

  return {
    marker: marker[0] as '`' | '~',
    length: marker.length,
  }
}

function normalizeMarkdownFenceLine(line: string): string {
  let normalized = line
  let next = stripBlockquotePrefix(normalized)

  while (next !== normalized) {
    normalized = next
    next = stripBlockquotePrefix(normalized)
  }

  return normalized
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .trimStart()
}

function stripBlockquotePrefix(line: string): string {
  return line.replace(/^\s{0,3}>\s?/, '')
}

function pushMarkdownBlock(
  blocks: StreamingMarkdownSplitBlock[],
  source: string,
  phase: ChatMarkdownRenderPhase,
): void {
  if (!source.trim()) {
    return
  }

  blocks.push({
    kind: resolveMarkdownBlockKind(source, phase),
    source,
  })
}

function resolveRevealTarget(input: StreamingMarkdownRenderInput, blocks: readonly StreamingMarkdownSplitBlock[]): { identity: string, source: string } | null {
  const block = blocks.at(-1)
  const index = blocks.length - 1

  if (!block || index < 0) {
    return null
  }

  const targetKind = resolveRevealTargetKind(block)
  if (!targetKind) {
    return null
  }

  return {
    identity: `${input.messageId}:${input.partId}:${index}:${targetKind}`,
    source: block.source,
  }
}

function resolveRevealTargetKind(block: StreamingMarkdownSplitBlock): StreamingMarkdownRevealTargetKind | null {
  if (block.kind === 'incomplete-code' || hasFenceMarker(block.source)) {
    return 'code'
  }

  if (block.kind === 'markdown' && isRevealableMarkdownSource(block.source)) {
    return 'markdown'
  }

  return null
}

function isRevealableMarkdownSource(source: string): boolean {
  return Boolean(source.trim())
    && !hasFenceMarker(source)
    && !isMarkdownTableLikeSource(source)
    && !hasMathMarker(source)
}

function isMarkdownTableLikeSource(source: string): boolean {
  return source.split('\n').some(line => line.trimStart().startsWith('|'))
}

function hasMathMarker(source: string): boolean {
  return source.includes('$') || source.includes('\\(') || source.includes('\\[')
}

function clampRevealVisibleSource(visibleSource: string, source: string): string {
  return source.startsWith(visibleSource) ? visibleSource : source
}

function requestRevealFrame(callback: FrameRequestCallback): StreamingMarkdownRevealFrame {
  if (typeof requestAnimationFrame === 'function') {
    return {
      id: requestAnimationFrame(callback),
      kind: 'raf',
    }
  }

  return {
    id: setTimeout(() => callback(resolveRevealNow()), STREAMING_TEXT_REVEAL_FRAME_FALLBACK_MS),
    kind: 'timeout',
  }
}

function cancelRevealFrame(frame: StreamingMarkdownRevealFrame): void {
  if (frame.kind === 'raf' && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(frame.id as number)
    return
  }

  clearTimeout(frame.id as ReturnType<typeof setTimeout>)
}

function takeGraphemes(input: string, count: number): GraphemeSlice {
  if (!input || count <= 0) {
    return { text: '', graphemeCount: 0 }
  }

  const segmenter = STREAMING_TEXT_REVEAL_GRAPHEME_SEGMENTER

  if (!segmenter) {
    const parts = Array.from(input).slice(0, count)
    return {
      graphemeCount: parts.length,
      text: parts.join(''),
    }
  }

  let text = ''
  let graphemeCount = 0

  for (const part of segmenter.segment(input)) {
    if (graphemeCount >= count) {
      break
    }

    text += part.segment
    graphemeCount += 1
  }

  return {
    graphemeCount,
    text,
  }
}

function createGraphemeSegmenter(): GraphemeSegmenter | null {
  if (typeof Intl === 'undefined') {
    return null
  }

  const SegmenterCtor = (Intl as unknown as {
    Segmenter?: new (locale?: string, options?: { granularity?: 'grapheme' }) => GraphemeSegmenter
  }).Segmenter

  return SegmenterCtor ? new SegmenterCtor(undefined, { granularity: 'grapheme' }) : null
}

function resolveRevealNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function resolveMarkdownBlockKind(source: string, phase: ChatMarkdownRenderPhase): ChatMarkdownBlock['kind'] {
  if (phase !== 'streaming') {
    return 'markdown'
  }

  if (isPartialMarkdownTable(source)) {
    return 'incomplete-table'
  }

  if (isPartialMarkdownMath(source)) {
    return 'incomplete-math'
  }

  return 'markdown'
}

function isPartialMarkdownTable(source: string): boolean {
  const lines = source.split('\n').map(line => line.trim()).filter(Boolean)
  const headerCells = getMarkdownTableCells(lines[0] ?? '')

  if (headerCells.length < 2) {
    return false
  }

  const separatorCells = getMarkdownTableCells(lines[1] ?? '')

  if (!separatorCells.length) {
    return true
  }

  if (separatorCells.length < headerCells.length) {
    return true
  }

  return !separatorCells.every(isMarkdownTableSeparatorCell)
}

function getMarkdownTableCells(line: string): string[] {
  const trimmed = line.trim()

  if (!trimmed.startsWith('|')) {
    return []
  }

  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())
    .filter(Boolean)
}

function isMarkdownTableSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell)
}

function isPartialMarkdownMath(source: string): boolean {
  return hasUnclosedBlockDollarMath(source) || hasUnclosedInlineMath(source)
}

function hasUnclosedBlockDollarMath(source: string): boolean {
  const lines = source.split('\n')
  const firstTextLineIndex = lines.findIndex(line => line.trim())

  if (firstTextLineIndex < 0) {
    return false
  }

  const firstLine = lines[firstTextLineIndex] ?? ''
  const firstLineStart = firstLine.trimStart()

  if (!firstLineStart.startsWith('$$')) {
    return false
  }

  if (firstLineStart.slice(2).includes('$$')) {
    return false
  }

  return !lines.slice(firstTextLineIndex + 1).some(line => line.trimEnd().endsWith('$$'))
}

function hasUnclosedInlineMath(source: string): boolean {
  let index = 0

  while (index < source.length) {
    const codeSpanEnd = getInlineCodeSpanEnd(source, index)

    if (codeSpanEnd >= 0) {
      index = codeSpanEnd
      continue
    }

    if (source.startsWith('\\(', index)) {
      const closingParen = findClosingParenMath(source, index + 2)

      if (closingParen < 0) {
        return true
      }

      index = closingParen + 2
      continue
    }

    if (source[index] === '$' && isLikelyInlineDollarMathOpening(source, index)) {
      const closingDollar = findClosingInlineDollar(source, index + 1)

      if (closingDollar < 0) {
        return true
      }

      index = closingDollar + 1
      continue
    }

    index += 1
  }

  return false
}

function getInlineCodeSpanEnd(source: string, index: number): number {
  const markerLength = getBacktickRunLength(source, index)

  if (!markerLength) {
    return -1
  }

  const closingIndex = source.indexOf('`'.repeat(markerLength), index + markerLength)
  return closingIndex < 0 ? source.length : closingIndex + markerLength
}

function getBacktickRunLength(source: string, index: number): number {
  if (source[index] !== '`') {
    return 0
  }

  let length = 1

  while (source[index + length] === '`') {
    length += 1
  }

  return length
}

function isLikelyInlineDollarMathOpening(source: string, index: number): boolean {
  if (source[index + 1] === '$' || isEscapedMarkdownCharacter(source, index)) {
    return false
  }

  const next = source[index + 1]

  if (!next || /\s/.test(next)) {
    return false
  }

  return !isLikelyCurrencyDollar(source, index)
}

function isLikelyCurrencyDollar(source: string, index: number): boolean {
  const previous = source[index - 1] ?? ''
  const next = source[index + 1] ?? ''

  return /\d/.test(next) && (!previous || /[\s([{，。、“”"':;!?]/.test(previous))
}

function findClosingInlineDollar(source: string, start: number): number {
  let index = start

  while (index < source.length) {
    const codeSpanEnd = getInlineCodeSpanEnd(source, index)

    if (codeSpanEnd >= 0) {
      index = codeSpanEnd
      continue
    }

    if (source[index] === '$' && source[index + 1] !== '$' && !isEscapedMarkdownCharacter(source, index)) {
      return index
    }

    index += 1
  }

  return -1
}

function findClosingParenMath(source: string, start: number): number {
  let index = start

  while (index < source.length - 1) {
    const codeSpanEnd = getInlineCodeSpanEnd(source, index)

    if (codeSpanEnd >= 0) {
      index = codeSpanEnd
      continue
    }

    if (source[index] === '\\' && source[index + 1] === ')') {
      return index
    }

    index += 1
  }

  return -1
}

function isEscapedMarkdownCharacter(source: string, index: number): boolean {
  let slashCount = 0
  let cursor = index - 1

  while (source[cursor] === '\\') {
    slashCount += 1
    cursor -= 1
  }

  return slashCount % 2 === 1
}
