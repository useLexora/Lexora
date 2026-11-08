// @vitest-environment jsdom
import type { Ref } from 'vue'
import type { ChatTranscriptDisplayRow } from '../../../model/transcript/chatMessageTime'
import type { ChatMessageScrollAnchor, ChatMessageScrollMetrics } from '../chatMessageViewport'
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
let currentVirtualizer: GeometryVirtualizer

class GeometryVirtualizer {
  readonly itemSizeCache = new Map<string, number>()
  readonly elementsCache = new Map<string, HTMLElement>()
  scrollRect = { width: 800, height: 200 }

  constructor(public options: GeometryOptions) {
    for (let index = 0; index < options.count; index++)
      this.itemSizeCache.set(options.getItemKey(index), geometry.rowHeight)
  }

  get scrollElement() {
    return this.options.getScrollElement()
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
    const element = this.options.getScrollElement()
    element.scrollTop = Math.max(0, Math.min(this.getOffsetForIndex(index)[0], element.scrollHeight - element.clientHeight))
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
      currentVirtualizer = instance
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
  const rows = shallowRef<ChatTranscriptDisplayRow[]>(Array.from({ length: 10 }, (_, index) => ({
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
  })))
  Object.defineProperties(scrollport, {
    clientHeight: { configurable: true, get: () => 200 },
    scrollHeight: { get: () => 24 + rows.value.length * geometry.rowHeight + 16 },
  })
  scrollport.scrollTop = 234
  let viewport!: ReturnType<typeof useChatTranscriptViewport>
  const observations: ChatMessageScrollMetrics[] = []
  const app = createApp({
    setup() {
      viewport = useChatTranscriptViewport(shallowRef(host), shallowRef(content), {
        rows: () => rows.value,
        hasTail: () => false,
        hasOlderMessages: () => false,
        following: () => false,
        editingMessageId: () => null,
      }, {
        onActiveMessageChange: () => {},
        onContentResize: metrics => observations.push(metrics),
        onReaderScrollIntent: () => {},
        onScroll: metrics => observations.push(metrics),
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
    content,
    rows,
    instance: currentVirtualizer,
    observations,
    report() {
      viewport.handleScroll()
      runFrame()
    },
    measured(index: number) {
      const element = document.createElement('div')
      content.append(element)
      Object.defineProperties(element, {
        offsetHeight: { get: () => geometry.rowHeight },
        offsetParent: { get: () => content },
      })
      currentVirtualizer.elementsCache.set(`row-${index}`, element)
    },
    resize() {
      rectListeners.forEach(listener => listener({ width: 700, height: 200 }))
    },
  }
}

it('does not interpret a hidden viewport as a measured empty transcript', async () => {
  const fixture = await mountViewport()
  const measured = fixture.handle.readScrollMetrics()
  Object.defineProperty(fixture.scrollport, 'clientHeight', { configurable: true, value: 0 })
  expect(fixture.handle.readScrollMetrics()).toBeNull()
  expect(fixture.handle.captureScrollAnchor()).toBeNull()
  Object.defineProperty(fixture.scrollport, 'clientHeight', { configurable: true, value: 200 })
  expect(fixture.handle.readScrollMetrics()).toEqual(measured)
})

it('retires an equal-size restoration without a size-cache entry and does not replay it after index changes', async () => {
  const fixture = await mountViewport()
  fixture.instance.itemSizeCache.clear()
  fixture.measured(2)
  fixture.handle.restoreScrollAnchor({ rowKey: 'row-2', rowSize: 100, messageId: 'message-2', messageOffsetTop: -10, metrics: fixture.handle.readScrollMetrics()! })
  fixture.report()
  fixture.scrollport.scrollTop = 534
  expect(fixture.handle.captureScrollAnchor()).toMatchObject({ rowKey: 'row-5', messageOffsetTop: -10 })
  fixture.rows.value = fixture.rows.value.slice(1)
  await nextTick()
  expect(fixture.scrollport.scrollTop).toBe(534)
})

it('retires a short-tail navigation at its reachable boundary', async () => {
  const fixture = await mountViewport()
  fixture.measured(9)
  fixture.handle.scrollToMessage('message-9')
  fixture.report()
  expect(fixture.handle.captureScrollAnchor()).toMatchObject({ rowKey: 'row-8', messageOffsetTop: -16 })
})

it('does not accept a bottom clamp before the remaining tail is measured', async () => {
  const fixture = await mountViewport()
  fixture.measured(8)
  fixture.handle.restoreScrollAnchor({ rowKey: 'row-8', rowSize: 100, messageId: 'message-8', messageOffsetTop: -80, metrics: fixture.handle.readScrollMetrics()! })
  fixture.report()
  expect(fixture.handle.captureScrollAnchor()).toMatchObject({ messageOffsetTop: -80 })
  fixture.measured(9)
  fixture.report()
  expect(fixture.handle.captureScrollAnchor()).toMatchObject({ rowKey: 'row-8', messageOffsetTop: -16 })
})

it('does not publish a transient tail clamp while a reading anchor is still being restored', async () => {
  const fixture = await mountViewport()
  fixture.handle.restoreScrollAnchor({ rowKey: 'row-2', rowSize: 100, messageId: 'message-2', messageOffsetTop: -10, metrics: fixture.handle.readScrollMetrics()! })
  fixture.scrollport.scrollTop = 840
  fixture.report()
  expect(fixture.observations).toEqual([])
  fixture.scrollport.scrollTop = 234
  fixture.measured(2)
  fixture.report()
  expect(fixture.observations).toEqual([{ clientHeight: 200, scrollHeight: 1040, scrollTop: 234 }])
})

it('resumes viewport observations when a pending anchor row is removed', async () => {
  const fixture = await mountViewport()
  fixture.handle.scrollToMessage('message-2')
  fixture.rows.value = fixture.rows.value.filter(row => row.key !== 'row-2')
  await nextTick()
  fixture.report()
  expect(fixture.observations.length).toBeGreaterThan(0)
})

it('normalizes an obsolete reading depth after a completed message shrinks', async () => {
  const fixture = await mountViewport()
  fixture.measured(2)
  fixture.handle.restoreScrollAnchor({ rowKey: 'row-2', rowSize: 600, messageId: 'message-2', messageOffsetTop: -500, metrics: { clientHeight: 200, scrollHeight: 1540, scrollTop: 724 } })
  fixture.report()
  fixture.report()
  expect(fixture.handle.captureScrollAnchor()).toMatchObject({ rowKey: 'row-2', messageOffsetTop: 0 })
  expect(fixture.content.style.height).toBe('1040px')
})

it('normalizes an unreachable reading depth in an execution input and resumes metrics', async () => {
  const fixture = await mountViewport()
  fixture.rows.value = fixture.rows.value.map(row => row.key === 'row-2'
    ? {
        kind: 'execution-input',
        key: row.key,
        input: {
          kind: 'supplement',
          messageId: 'supplement-1',
          text: 'A long supplementary input',
          createdAt: '2026-01-01T00:00:00.000Z',
          state: 'consumed',
          conversationId: 'conversation-test',
          branchId: 'branch-test',
          runId: 'run-test',
          rootRunId: 'run-test',
          buddyId: 'default',
          buddyName: 'Lexora',
          task: '',
        },
      }
    : row)
  await nextTick()
  fixture.measured(2)
  fixture.handle.restoreScrollAnchor({ rowKey: 'row-2', rowSize: 600, messageId: '', messageOffsetTop: -500, metrics: { clientHeight: 200, scrollHeight: 1540, scrollTop: 724 } })
  fixture.report()
  fixture.report()
  expect(fixture.handle.captureScrollAnchor()).toMatchObject({ rowKey: 'row-2', messageOffsetTop: 0 })
  expect(fixture.observations.at(-1)).toEqual({ clientHeight: 200, scrollHeight: 1040, scrollTop: 224 })
})

it('does not treat an incomplete streaming render as a completed message shrinking', async () => {
  const fixture = await mountViewport()
  fixture.rows.value = fixture.rows.value.map(row => row.key === 'row-2' ? { ...row, streaming: true } : row)
  await nextTick()
  fixture.measured(2)
  fixture.handle.restoreScrollAnchor({ rowKey: 'row-2', rowSize: 600, messageId: 'message-2', messageOffsetTop: -500, metrics: { clientHeight: 200, scrollHeight: 1540, scrollTop: 724 } })
  fixture.report()
  expect(fixture.handle.captureScrollAnchor()).toMatchObject({ rowKey: 'row-2', messageOffsetTop: -500 })
  expect(fixture.content.style.height).toBe('1540px')
})

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
    ...(target === 'tail' ? { rowSize: geometry.rowHeight } : {}),
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
