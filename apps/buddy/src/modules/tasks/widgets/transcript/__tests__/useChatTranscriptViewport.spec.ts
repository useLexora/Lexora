// @vitest-environment jsdom
import type { Ref } from 'vue'
import type { ChatTranscriptDisplayRow } from '../../../model/transcript/chatMessageTime'
import type { ChatMessageScrollAnchor } from '../chatMessageViewport'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, onScopeDispose, shallowRef, watch } from 'vue'
import { useChatTranscriptViewport } from '../useChatTranscriptViewport'

interface Rect {
  width: number
  height: number
}

interface GeometryOptions {
  count: number
  paddingStart: number
  paddingEnd: number
  scrollPaddingStart: number
  getScrollElement: () => HTMLElement
  getItemKey: (index: number) => string
  observeElementRect: (instance: GeometryVirtualizer, callback: (rect: Rect) => void) => () => void
}

const geometry = { rowHeight: 100, nextRowHeight: 100 }
const rectListeners = new Set<(rect: Rect) => void>()
const frames = new Map<number, FrameRequestCallback>()
const cleanups: (() => void)[] = []
let frameId = 0

class GeometryVirtualizer {
  readonly itemSizeCache = new Map<string, number>()
  scrollRect = { width: 800, height: 200 }

  constructor(public options: GeometryOptions) {
    for (let index = 0; index < options.count; index++)
      this.itemSizeCache.set(options.getItemKey(index), geometry.rowHeight)
  }

  setOptions(options: GeometryOptions) {
    this.options = options
  }

  getVirtualItems() {
    return Array.from({ length: this.options.count }, (_, index) => ({
      index,
      key: this.options.getItemKey(index),
      start: this.options.paddingStart + index * geometry.rowHeight,
      end: this.options.paddingStart + (index + 1) * geometry.rowHeight,
      size: geometry.rowHeight,
      lane: 0,
    }))
  }

  getTotalSize() {
    return this.options.paddingStart + this.options.count * geometry.rowHeight + this.options.paddingEnd
  }

  getOffsetForIndex(index: number) {
    return [this.options.paddingStart + index * geometry.rowHeight - this.options.scrollPaddingStart, 'start'] as const
  }

  scrollToIndex(index: number) {
    this.options.getScrollElement().scrollTop = this.getOffsetForIndex(index)[0]
  }

  scrollToEnd() {
    const element = this.options.getScrollElement()
    element.scrollTop = this.getTotalSize() - element.clientHeight
  }

  measure() {
    geometry.rowHeight = geometry.nextRowHeight
    this.itemSizeCache.clear()
  }
}

vi.mock('@tanstack/vue-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/vue-virtual')>()
  return {
    ...actual,
    observeElementRect: (_instance: GeometryVirtualizer, callback: (rect: Rect) => void) => {
      rectListeners.add(callback)
      callback({ width: 800, height: 200 })
      return () => rectListeners.delete(callback)
    },
    useVirtualizer: (options: Readonly<Ref<GeometryOptions>>) => {
      const instance = new GeometryVirtualizer(options.value)
      watch(options, value => instance.setOptions(value), { flush: 'sync' })
      const stop = options.value.observeElementRect(instance, rect => instance.scrollRect = rect)
      onScopeDispose(stop)
      return shallowRef(instance)
    },
  }
})

beforeEach(() => {
  geometry.rowHeight = 100
  geometry.nextRowHeight = 100
  rectListeners.clear()
  frames.clear()
  frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})

afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  vi.unstubAllGlobals()
  frames.clear()
  rectListeners.clear()
})

function runFrame() {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach(callback => callback(0))
}

async function mountViewport() {
  const host = document.createElement('div')
  const mountPoint = document.createElement('div')
  const scrollport = document.createElement('div')
  scrollport.className = 'buddy-chat-transcript-viewport__scrollport'
  const content = document.createElement('div')
  scrollport.append(content)
  host.append(mountPoint, scrollport)
  document.body.append(host)
  Object.defineProperties(scrollport, {
    clientHeight: { get: () => 200 },
    scrollHeight: { get: () => 24 + 10 * geometry.rowHeight + 16 },
  })
  scrollport.scrollTop = 234
  const rows: ChatTranscriptDisplayRow[] = Array.from({ length: 10 }, (_, index) => ({
    kind: 'message',
    key: `row-${index}`,
    turnOutputs: null,
    message: {
      id: `message-${index}`,
      role: 'user',
      attachments: [],
      branchId: 'branch-test',
      content: { text: `Message ${index}` },
      conversationId: 'conversation-test',
      createdAt: '2026-09-08T00:00:00.000Z',
      runId: null,
    },
  }))
  let viewport!: ReturnType<typeof useChatTranscriptViewport>
  const app = createApp({
    setup() {
      viewport = useChatTranscriptViewport(shallowRef(host), shallowRef(content), {
        rows: () => rows,
        hasTail: () => false,
        hasOlderMessages: () => false,
        following: () => false,
        editingMessageId: () => null,
      }, {
        onActiveMessageChange: () => {},
        onContentResize: () => {},
        onReaderScrollIntent: () => {},
        onScroll: () => {},
      })
      return () => null
    },
  })
  app.mount(mountPoint)
  cleanups.push(() => {
    app.unmount()
    host.remove()
  })
  await nextTick()
  return {
    handle: viewport.handle,
    scrollport,
    resize() {
      rectListeners.forEach(listener => listener({ width: 700, height: 200 }))
    },
  }
}

type Navigation = 'message' | 'tail' | 'restore'
const expectedTargets = {
  message: { top: 624, rowKey: 'row-6', messageId: 'message-6', offset: 0 },
  tail: { top: 840, rowKey: 'row-8', messageId: 'message-8', offset: -16 },
  restore: { top: 506, rowKey: 'row-5', messageId: 'message-5', offset: 18 },
}

function navigate(fixture: Awaited<ReturnType<typeof mountViewport>>, target: Navigation) {
  if (target === 'message')
    return fixture.handle.scrollToMessage('message-6')
  if (target === 'tail')
    return fixture.handle.scrollToTail()
  const anchor: ChatMessageScrollAnchor = {
    rowKey: 'row-5',
    messageId: 'message-5',
    messageOffsetTop: 18,
    metrics: { clientHeight: 200, scrollHeight: 1040, scrollTop: 506 },
  }
  return fixture.handle.restoreScrollAnchor(anchor)
}

function expectTarget(fixture: Awaited<ReturnType<typeof mountViewport>>, target: Navigation) {
  const expected = expectedTargets[target]
  expect(fixture.scrollport.scrollTop).toBe(expected.top)
  expect(fixture.handle.readScrollMetrics()).toEqual({ clientHeight: 200, scrollHeight: 1040, scrollTop: expected.top })
  expect(fixture.handle.captureScrollAnchor()).toEqual({
    rowKey: expected.rowKey,
    messageId: expected.messageId,
    messageOffsetTop: expected.offset,
    metrics: { clientHeight: 200, scrollHeight: 1040, scrollTop: expected.top },
  })
}

describe('transcript resize and explicit navigation ordering', () => {
  it('restores the reading anchor after a resize when no newer navigation supersedes it', async () => {
    const fixture = await mountViewport()
    expect(fixture.handle.captureScrollAnchor()).toMatchObject({ rowKey: 'row-2', messageOffsetTop: -10 })
    geometry.nextRowHeight = 110
    fixture.resize()
    expect(frames.size).toBe(1)
    runFrame()
    expect(fixture.scrollport.scrollTop).toBe(234)
    await nextTick()
    expect(fixture.scrollport.scrollTop).toBe(254)
    expect(fixture.handle.captureScrollAnchor()).toMatchObject({
      rowKey: 'row-2',
      messageId: 'message-2',
      messageOffsetTop: -10,
      metrics: { scrollTop: 254, scrollHeight: 1140 },
    })
  })

  describe.each(['before-frame', 'after-frame-before-tick'] as const)('%s', (timing) => {
    it.each(['message', 'tail', 'restore'] as const)('keeps explicit %s positioning instead of returning to the queued resize anchor', async (target) => {
      const fixture = await mountViewport()
      expect(fixture.handle.captureScrollAnchor()).toMatchObject({ rowKey: 'row-2', messageOffsetTop: -10 })
      fixture.resize()
      expect(frames.size).toBe(1)
      if (timing === 'after-frame-before-tick')
        runFrame()
      expect(navigate(fixture, target)?.scrollTop).toBe(expectedTargets[target].top)
      expectTarget(fixture, target)
      if (timing === 'before-frame')
        runFrame()
      await nextTick()
      expectTarget(fixture, target)
      runFrame()
      await nextTick()
      expectTarget(fixture, target)
    })
  })
})
