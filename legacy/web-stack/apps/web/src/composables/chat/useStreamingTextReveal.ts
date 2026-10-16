import type { MaybeRefOrGetter } from 'vue'
import { onScopeDispose, shallowRef, toValue, watch } from 'vue'

const STREAMING_TEXT_REVEAL_GRAPHEME_MS = 16
const STREAMING_TEXT_REVEAL_FRAME_FALLBACK_MS = 16
const STREAMING_TEXT_REVEAL_BACKLOG_MEDIUM = 24
const STREAMING_TEXT_REVEAL_BACKLOG_LARGE = 96
const STREAMING_TEXT_REVEAL_BACKLOG_XLARGE = 240

interface StreamingTextRevealFrame {
  id: number | ReturnType<typeof setTimeout>
  kind: 'raf' | 'timeout'
}

interface StreamingTextRevealInput {
  identity: string
  source: string
  animate: boolean
  maxGraphemesPerFrame: number
}

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

export interface UseStreamingTextRevealOptions {
  identity: MaybeRefOrGetter<string>
  source: MaybeRefOrGetter<string>
  animate: MaybeRefOrGetter<boolean>
  maxGraphemesPerFrame?: MaybeRefOrGetter<number>
}

export function useStreamingTextReveal(options: UseStreamingTextRevealOptions) {
  const visibleText = shallowRef('')
  let latestInput: StreamingTextRevealInput | null = null
  let frame: StreamingTextRevealFrame | null = null
  let lastTick = 0

  function clearFrame(): void {
    if (!frame) {
      return
    }

    cancelRevealFrame(frame)
    frame = null
  }

  function scheduleTick(): void {
    const input = latestInput

    if (!input || frame || visibleText.value.length >= input.source.length) {
      return
    }

    frame = requestRevealFrame(advanceReveal)
  }

  function advanceReveal(timestamp: number): void {
    frame = null

    const input = latestInput
    if (!input || visibleText.value.length >= input.source.length) {
      lastTick = 0
      return
    }

    if (!lastTick) {
      lastTick = timestamp - STREAMING_TEXT_REVEAL_GRAPHEME_MS
    }

    if (timestamp - lastTick < STREAMING_TEXT_REVEAL_GRAPHEME_MS) {
      scheduleTick()
      return
    }

    lastTick = timestamp

    const remainingText = input.source.slice(visibleText.value.length)
    const nextSlice = takeGraphemes(remainingText, resolveRevealGraphemeCount(remainingText.length, input.maxGraphemesPerFrame))
    if (!nextSlice.text) {
      scheduleTick()
      return
    }

    visibleText.value += nextSlice.text

    if (visibleText.value.length >= input.source.length) {
      lastTick = 0
    }

    scheduleTick()
  }

  watch(() => ({
    animate: toValue(options.animate),
    identity: toValue(options.identity),
    maxGraphemesPerFrame: resolveMaxGraphemesPerFrame(toValue(options.maxGraphemesPerFrame)),
    source: toValue(options.source),
  }), (input) => {
    const previousInput = latestInput
    const canContinue = Boolean(previousInput
      && previousInput.identity === input.identity
      && input.source.startsWith(previousInput.source))

    latestInput = input

    if (!input.source) {
      clearFrame()
      visibleText.value = ''
      lastTick = 0
      return
    }

    if (!input.animate) {
      clearFrame()
      visibleText.value = input.source
      lastTick = 0
      return
    }

    if (!canContinue) {
      clearFrame()
      visibleText.value = ''
      lastTick = 0
    }
    else if (!input.source.startsWith(visibleText.value)) {
      visibleText.value = ''
      lastTick = 0
    }

    scheduleTick()
  }, {
    flush: 'sync',
    immediate: true,
  })

  onScopeDispose(() => {
    clearFrame()
  })

  return {
    visibleText,
  }
}

function requestRevealFrame(callback: FrameRequestCallback): StreamingTextRevealFrame {
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

function cancelRevealFrame(frame: StreamingTextRevealFrame): void {
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

function resolveRevealGraphemeCount(backlogLength: number, maxGraphemesPerFrame: number): number {
  if (maxGraphemesPerFrame <= 1 || backlogLength <= STREAMING_TEXT_REVEAL_BACKLOG_MEDIUM) {
    return 1
  }

  if (backlogLength <= STREAMING_TEXT_REVEAL_BACKLOG_LARGE) {
    return Math.min(2, maxGraphemesPerFrame)
  }

  if (backlogLength <= STREAMING_TEXT_REVEAL_BACKLOG_XLARGE) {
    return Math.min(4, maxGraphemesPerFrame)
  }

  return maxGraphemesPerFrame
}

function resolveMaxGraphemesPerFrame(input: number | undefined): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return 1
  }

  return Math.max(1, Math.floor(input))
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
