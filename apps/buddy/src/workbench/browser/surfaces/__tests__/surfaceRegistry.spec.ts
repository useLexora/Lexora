// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { SemanticAnchorRegistry } from '../SemanticAnchorRegistry'
import { WorkbenchPaneRegistry } from '../WorkbenchPaneRegistry'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

it('publishes immutable geometry and immediate withdrawal without removing a replacement registration', async () => {
  const registry = new WorkbenchPaneRegistry(() => 'pane')
  const root = document.createElement('div')
  const first = document.createElement('div')
  const second = document.createElement('div')
  root.append(first, second)
  document.body.append(root)
  root.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)
  first.getBoundingClientRect = () => new DOMRect(0, 0, 400, 600)
  second.getBoundingClientRect = () => new DOMRect(400, 0, 400, 600)
  registry.register(null, root)
  registry.start()
  const releaseFirst = registry.register('pane', first)
  const initial = registry.snapshot
  const releaseSecond = registry.register('pane', second)
  releaseFirst()
  expect(registry.snapshot[0]?.rect.x).toBe(400)
  expect(initial[0]?.rect.x).toBe(0)
  expect(Reflect.set(registry.snapshot[0]!.rect, 'width', 0)).toBe(false)
  const revision = registry.revision
  registry.invalidate()
  await vi.advanceTimersByTimeAsync(20)
  expect(registry.revision).toBe(revision)
  releaseSecond()
  expect(registry.snapshot).toEqual([])
  registry.dispose()
})

it('keeps reactive anchor reads and independent registration lifetimes behind a readonly view', () => {
  const registry = new SemanticAnchorRegistry()
  const count = computed(() => registry.entries.size)
  const element = document.createElement('div')
  const observed: string[] = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
  registry.onDidChange(() => {
    throw new Error('observer')
  })
  registry.onDidChange(event => observed.push(event.kind))
  const first = registry.register('workbench.pane', element)
  const second = registry.register('workbench.pane', element)
  expect(count.value).toBe(2)
  first()
  first()
  expect(count.value).toBe(1)
  const anchor = [...registry.entries.values()][0]!
  expect(Reflect.set(anchor, 'id', 'changed')).toBe(false)
  registry.dispose()
  second()
  expect(count.value).toBe(0)
  expect(observed).toEqual(['registered', 'registered', 'removed', 'removed'])
})
