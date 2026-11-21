// @vitest-environment jsdom
import type { ReaderEntry } from '../readerBridge'
import type { ReaderAnchor } from '../readerProjection'
import type { ReaderUpdate } from '../readerProtocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { useReaderViewport } from '../useReaderViewport'

const disposals: (() => void)[] = []
const entry = (id: string): ReaderEntry => ({ id, continuation: false, messages: [{ id, role: 'assistant', text: '' } as ReaderEntry['messages'][number]] })

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.className === 'viewport' ? 400 : 100
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return Number(this.firstElementChild?.getAttribute('data-height') ?? 0)
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const row = this.closest<HTMLElement>('[data-index]')
    const top = row ? Number(row.dataset.start) - (this.closest('.viewport')?.scrollTop ?? 0) : 0
    return { top, bottom: top + 100, left: 0, right: 300, width: 300, height: 100, x: 0, y: top, toJSON: () => ({}) }
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, options.top ?? 0))
    this.dispatchEvent(new Event('scroll'))
  } })
})
afterEach(() => {
  disposals.splice(0).forEach(dispose => dispose())
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo
  vi.useRealTimers()
})

async function settle() {
  await nextTick()
  for (let frame = 0; frame < 16; frame++) {
    await vi.advanceTimersByTimeAsync(20)
    await nextTick()
  }
}
function mount(onOlder: (retry: boolean) => void = () => {}) {
  const state = shallowRef<NonNullable<ReaderUpdate['history']>>({ available: true, loading: false, error: null })
  const entries = shallowRef(Array.from({ length: 60 }, (_, index) => entry(`message-${index + 21}`)))
  const topic = shallowRef('one')
  const anchor = shallowRef<ReaderAnchor | null>(null)
  const hasLater = shallowRef(false)
  const requests: string[] = []
  let view!: ReturnType<typeof useReaderViewport>
  let viewport!: HTMLElement
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    setup() {
      const element = shallowRef<HTMLElement | null>(null)
      view = useReaderViewport(element, entries, topic, anchor, hasLater, () => requests.push(topic.value), { state, load: onOlder })
      return () => h('div', {
        class: 'viewport',
        ref: (value) => {
          element.value = value as HTMLElement
          viewport = value as HTMLElement
        },
        onScroll: view.scroll,
      }, [
        h('div', { 'data-height': view.height.value }, view.rows.value.map(row => h('section', { 'key': String(row.key), 'ref': view.measure, 'data-index': row.index, 'data-start': row.start }, [h('article', { 'data-message-id': row.entry.messages[0]!.id })]))),
      ])
    },
  })
  app.mount(root)
  disposals.push(() => {
    app.unmount()
    root.remove()
  })
  return {
    entries,
    topic,
    anchor,
    hasLater,
    state,
    requests,
    get viewport() {
      return viewport
    },
    view,
  }
}

describe('reader viewport navigation', () => {
  it('locates only new requests and preserves an offset through prepend and ordinary updates', async () => {
    const reader = mount()
    await settle()
    reader.anchor.value = { topic: 'one', messageId: 'message-40', requestId: 'search-1' }
    reader.hasLater.value = true
    await settle()
    expect(reader.view.anchorStatus.value).toBe('located')
    expect(reader.view.locatedMessageId.value).toBe('message-40')
    reader.viewport.scrollTop += 35
    reader.viewport.dispatchEvent(new Event('scroll'))
    await settle()
    const offset = reader.viewport.querySelector('[data-message-id="message-40"]')!.getBoundingClientRect().top
    reader.entries.value = [entry('message-19'), entry('message-20'), ...reader.entries.value]
    await settle()
    expect(reader.viewport.querySelector('[data-message-id="message-40"]')!.getBoundingClientRect().top).toBeCloseTo(offset)
    reader.entries.value = reader.entries.value.map(item => ({ ...item }))
    reader.anchor.value = { ...reader.anchor.value! }
    await settle()
    expect(reader.viewport.querySelector('[data-message-id="message-40"]')!.getBoundingClientRect().top).toBeCloseTo(offset)
    const beforeLatest = reader.viewport.scrollTop
    reader.view.latest()
    await settle()
    expect(reader.requests).toEqual(['one'])
    expect(reader.viewport.scrollTop).toBe(beforeLatest)
    reader.entries.value = [...reader.entries.value, entry('latest')]
    reader.anchor.value = null
    reader.hasLater.value = false
    await settle()
    expect(reader.viewport.scrollTop).toBeCloseTo(reader.viewport.scrollHeight - reader.viewport.clientHeight)
  })

  it('prefetches one earlier page per boundary without loading history during initial positioning or prepend', async () => {
    const older = vi.fn(() => true)
    const reader = mount(older)
    await settle()
    expect(older).not.toHaveBeenCalled()
    const move = (offset: number) => {
      reader.viewport.scrollTop = offset
      reader.viewport.dispatchEvent(new Event('scroll'))
    }
    move(290)
    move(180)
    await settle()
    expect(older).toHaveBeenCalledTimes(1)
    const marker = reader.viewport.querySelector('[data-message-id="message-23"]')!.getBoundingClientRect().top
    reader.entries.value = [entry('message-19'), entry('message-20'), ...reader.entries.value]
    await settle()
    expect(reader.viewport.querySelector('[data-message-id="message-23"]')!.getBoundingClientRect().top).toBeCloseTo(marker)
    expect(older).toHaveBeenCalledTimes(1)
    move(100)
    expect(older).toHaveBeenCalledTimes(2)
  })

  it('fills a short viewport one confirmed page at a time, including empty pages, and stops at overflow', async () => {
    const load = vi.fn()
    const reader = mount(load)
    reader.entries.value = [entry('short')]
    reader.state.value = { available: true, loading: false, error: null, page: 1 }
    await settle()
    expect(load.mock.calls).toEqual([[false]])
    reader.state.value = { ...reader.state.value, loading: true }
    await settle()
    reader.state.value = { ...reader.state.value, loading: false, page: 2 }
    await settle()
    expect(load.mock.calls).toEqual([[false], [false]])
    reader.entries.value = [entry('a'), entry('b'), entry('c'), ...reader.entries.value]
    reader.state.value = { ...reader.state.value, page: 3 }
    await settle()
    expect(load).toHaveBeenCalledTimes(2)
    reader.entries.value = []
    reader.state.value = { ...reader.state.value, available: false }
    await settle()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('waits for explicit retry after failure, without treating a live row update as a new page', async () => {
    const load = vi.fn()
    const reader = mount(load)
    reader.entries.value = []
    reader.state.value = { available: true, loading: false, error: null, page: 7 }
    await settle()
    reader.entries.value = [entry('live')]
    await settle()
    reader.state.value = { ...reader.state.value, error: 'offline' }
    await settle()
    expect(load.mock.calls).toEqual([[false]])
    reader.view.retryOlder()
    expect(load.mock.calls).toEqual([[false], [true]])
  })

  it('reports missing IDs without falling back to the end, and cancels pending navigation on a topic change', async () => {
    const reader = mount()
    await settle()
    reader.anchor.value = { topic: 'one', messageId: 'message-40', requestId: 'search-1' }
    await settle()
    const top = reader.viewport.scrollTop
    reader.anchor.value = { topic: 'one', messageId: 'missing', requestId: 'search-2' }
    await settle()
    expect(reader.view.anchorStatus.value).toBe('missing')
    expect(reader.viewport.scrollTop).toBe(top)
    expect(reader.view.showLatest.value).toBe(true)
    reader.anchor.value = { topic: 'one', messageId: 'message-30', requestId: 'search-3' }
    await nextTick()
    reader.topic.value = 'two'
    reader.entries.value = [entry('other')]
    reader.anchor.value = null
    await settle()
    expect(reader.view.locatedMessageId.value).toBeNull()
    expect(reader.view.anchorStatus.value).toBe('idle')
  })
})
