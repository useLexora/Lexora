import type { ExtensionDataQuery, ExtensionDataSnapshot, ExtensionDataSource } from '@buddy-shared/extensions/extensionData'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionDataClient } from '../ExtensionDataClient'

const query = { source: 'task.metrics', scope: 'bound' } as const
const contextQuery = { source: 'context.usage', scope: 'bound' } as const

function metrics(turns = 1, taskId = 'task-a'): ExtensionDataSnapshot<'task.metrics'> {
  return {
    source: 'task.metrics',
    status: 'ready',
    value: {
      taskId,
      branchId: 'branch',
      turns,
      steps: turns,
      tokens: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      throughput: { samples: 1, tokensPerSecond: 10 },
    },
  }
}

const context: ExtensionDataSnapshot<'context.usage'> = {
  source: 'context.usage',
  status: 'ready',
  value: { taskId: 'task-a', branchId: 'branch', actorId: 'actor', runId: null, tokens: 100, window: 1000, percent: 10 },
}

function deferred() {
  let resolve!: (snapshot: ExtensionDataSnapshot) => void
  const promise = new Promise<ExtensionDataSnapshot>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

const clients: ExtensionDataClient[] = []

function fixture() {
  const updates: { id: string, snapshot: ExtensionDataSnapshot | null }[] = []
  const listeners = new Set<() => void>()
  const state = {
    sources: ['task.metrics', 'context.usage'] as readonly ExtensionDataSource[],
    key: 'scope-a' as string | null,
    value: metrics(),
  }
  const read = vi.fn(async (source: ExtensionDataSource): Promise<ExtensionDataSnapshot> => source === 'task.metrics' ? state.value : context)
  const client = new ExtensionDataClient({
    sources: () => state.sources,
    binding: source => state.key === null ? null : { key: state.key, read: () => read(source) },
    publish: update => updates.push(update),
    observeChanges: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  clients.push(client)
  return { client, state, read, updates, listeners, change: () => [...listeners].forEach(listener => listener()) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  clients.splice(0).forEach(client => client.dispose())
  vi.useRealTimers()
})

describe('extensionDataClient', () => {
  it('returns actual typed source snapshots without keeping a value cache', async () => {
    const f = fixture()
    expect(await f.client.read(query)).toEqual(metrics())
    expect(await f.client.read(contextQuery)).toEqual(context)
    f.state.value = metrics(3)
    expect(await f.client.read(query)).toEqual(metrics(3))
    expect(f.listeners.size).toBe(0)
  })

  it('distinguishes denied, no target and unavailable without synthetic zero data', async () => {
    const f = fixture()
    f.state.sources = []
    expect(await f.client.read(query)).toEqual({ source: 'task.metrics', status: 'denied', value: null })
    f.state.sources = ['task.metrics']
    f.state.key = null
    expect(await f.client.read(query)).toEqual({ source: 'task.metrics', status: 'no_target', value: null })
    expect(f.read).not.toHaveBeenCalled()
    f.state.key = 'scope-a'
    f.read.mockRejectedValueOnce(new Error('temporarily unavailable'))
    expect(await f.client.read(query)).toEqual({ source: 'task.metrics', status: 'unavailable', value: null })
  })

  it('merges concurrent reads and observations for the same source and scope', async () => {
    const f = fixture()
    const pending = deferred()
    f.read.mockReturnValueOnce(pending.promise)
    const reads = Array.from({ length: 40 }, () => f.client.read(query))
    f.client.observe({ id: 'first', query })
    f.client.observe({ id: 'second', query })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.read).toHaveBeenCalledTimes(1)
    expect(f.listeners.size).toBe(1)
    pending.resolve(metrics(2))
    expect(await Promise.all(reads)).toEqual(Array.from({ length: 40 }, () => metrics(2)))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.updates).toEqual([{ id: 'first', snapshot: metrics(2) }, { id: 'second', snapshot: metrics(2) }])
  })

  it('subscribes before the asynchronous first read and rereads changes received during it', async () => {
    const f = fixture()
    const pending = deferred()
    f.read.mockImplementationOnce(async () => {
      expect(f.listeners.size).toBe(1)
      f.state.value = metrics(8)
      f.change()
      return pending.promise
    })
    f.client.observe({ id: 'first', query })
    expect(f.updates).toEqual([])
    await vi.advanceTimersByTimeAsync(120)
    pending.resolve(metrics(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.updates).toEqual([])
    await vi.advanceTimersByTimeAsync(120)
    expect(f.updates).toEqual([{ id: 'first', snapshot: metrics(8) }])
    expect(f.read).toHaveBeenCalledTimes(2)
  })

  it('coalesces domain events and shares each refresh across subscriptions', async () => {
    const f = fixture()
    f.client.observe({ id: 'first', query })
    f.client.observe({ id: 'second', query })
    f.client.observe({ id: 'context', query: contextQuery })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.updates).toEqual([
      { id: 'first', snapshot: metrics() },
      { id: 'second', snapshot: metrics() },
      { id: 'context', snapshot: context },
    ])
    f.updates.length = 0
    f.state.value = metrics(5)
    for (let index = 0; index < 50; index++)
      f.change()
    await vi.advanceTimersByTimeAsync(119)
    expect(f.updates).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(f.updates).toEqual([
      { id: 'first', snapshot: metrics(5) },
      { id: 'second', snapshot: metrics(5) },
      { id: 'context', snapshot: context },
    ])
    expect(f.read).toHaveBeenCalledTimes(4)
  })

  it('synchronously clears revoked snapshots and rejects late results without further reads', async () => {
    const f = fixture()
    f.client.observe({ id: 'first', query })
    await vi.advanceTimersByTimeAsync(0)
    const pending = deferred()
    f.read.mockReturnValueOnce(pending.promise)
    const directRead = f.client.read(query)
    await vi.advanceTimersByTimeAsync(0)
    f.state.sources = []
    f.client.refresh()
    expect(f.updates.at(-1)).toEqual({ id: 'first', snapshot: { source: 'task.metrics', status: 'denied', value: null } })
    const before = f.read.mock.calls.length
    pending.resolve(metrics(9))
    expect(await directRead).toEqual({ source: 'task.metrics', status: 'denied', value: null })
    await vi.advanceTimersByTimeAsync(500)
    expect(f.read).toHaveBeenCalledTimes(before)
    expect(f.updates.slice(1).every(update => update.snapshot?.status === 'denied')).toBe(true)
  })

  it('clears old scope immediately and never publishes its late result', async () => {
    const f = fixture()
    const pending = deferred()
    f.read.mockReturnValueOnce(pending.promise)
    f.client.observe({ id: 'first', query })
    const directRead = f.client.read(query)
    await vi.advanceTimersByTimeAsync(0)
    f.state.key = 'scope-b'
    f.state.value = metrics(4, 'task-b')
    f.change()
    expect(f.updates).toEqual([{ id: 'first', snapshot: { source: 'task.metrics', status: 'unavailable', value: null } }])
    pending.resolve(metrics(12, 'task-a'))
    expect(await directRead).toEqual({ source: 'task.metrics', status: 'unavailable', value: null })
    await vi.advanceTimersByTimeAsync(120)
    expect(f.updates.at(-1)).toEqual({ id: 'first', snapshot: metrics(4, 'task-b') })
    expect(f.updates.some(update => update.snapshot?.status === 'ready' && update.snapshot.source === 'task.metrics' && update.snapshot.value.taskId === 'task-a')).toBe(false)
  })

  it('reads the new scope without waiting for a stale scope provider to finish', async () => {
    const f = fixture()
    const stale = deferred()
    f.read.mockReturnValueOnce(stale.promise)
    f.client.observe({ id: 'first', query })
    await vi.advanceTimersByTimeAsync(0)
    f.state.key = 'scope-b'
    f.state.value = metrics(6, 'task-b')
    f.change()
    await vi.advanceTimersByTimeAsync(120)
    expect(f.updates.at(-1)).toEqual({ id: 'first', snapshot: metrics(6, 'task-b') })
    stale.resolve(metrics(13, 'task-a'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.updates).toEqual([
      { id: 'first', snapshot: { source: 'task.metrics', status: 'unavailable', value: null } },
      { id: 'first', snapshot: metrics(6, 'task-b') },
    ])
  })

  it('invalidates A-B-A and revoked-then-restored pending reads', async () => {
    const f = fixture()
    const pending = deferred()
    f.read.mockReturnValueOnce(pending.promise)
    const result = f.client.read(query)
    await vi.advanceTimersByTimeAsync(0)
    f.state.key = 'scope-b'
    f.change()
    f.state.key = 'scope-a'
    f.change()
    f.state.sources = []
    f.change()
    f.state.sources = ['task.metrics']
    f.change()
    pending.resolve(metrics(9))
    expect(await result).toEqual({ source: 'task.metrics', status: 'unavailable', value: null })
    expect(f.listeners.size).toBe(0)
  })

  it.each(['scope', 'permission'] as const)('revalidates %s even without a notification', async (change) => {
    const f = fixture()
    const pending = deferred()
    f.read.mockReturnValueOnce(pending.promise)
    const result = f.client.read(query)
    await vi.advanceTimersByTimeAsync(0)
    if (change === 'scope')
      f.state.key = null
    else
      f.state.sources = []
    pending.resolve(metrics())
    expect(await result).toEqual({ source: 'task.metrics', status: change === 'scope' ? 'no_target' : 'denied', value: null })
  })

  it('checks permissions again immediately before starting a deferred provider read', async () => {
    const f = fixture()
    const result = f.client.read(query)
    f.state.sources = []
    expect(await result).toEqual({ source: 'task.metrics', status: 'denied', value: null })
    expect(f.read).not.toHaveBeenCalled()
  })

  it('restores a previously unbound observation only when an actual binding exists', async () => {
    const f = fixture()
    f.state.key = null
    f.client.observe({ id: 'first', query })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.updates).toEqual([{ id: 'first', snapshot: { source: 'task.metrics', status: 'no_target', value: null } }])
    f.state.key = 'scope-a'
    f.change()
    expect(f.updates.at(-1)?.snapshot).toEqual({ source: 'task.metrics', status: 'unavailable', value: null })
    await vi.advanceTimersByTimeAsync(120)
    expect(f.updates.at(-1)).toEqual({ id: 'first', snapshot: metrics() })
  })

  it('bounds observations, deduplicates identical IDs and rejects query replacement', async () => {
    const f = fixture()
    for (let index = 0; index < 32; index++)
      f.client.observe({ id: String(index), query })
    f.client.observe({ id: '0', query })
    expect(() => f.client.observe({ id: '0', query: contextQuery })).toThrow('already in use')
    expect(() => f.client.observe({ id: 'overflow', query })).toThrow('limit')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.updates).toHaveLength(32)
    expect(f.updates.every(update => update.snapshot?.status === 'ready')).toBe(true)
    f.client.unobserve('0')
    f.client.observe({ id: 'replacement', query: contextQuery })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.updates.at(-1)).toEqual({ id: 'replacement', snapshot: context })
  })

  it('deletes restore snapshots once and releases the last consumer during a pending read', async () => {
    const f = fixture()
    const pending = deferred()
    f.read.mockReturnValueOnce(pending.promise)
    f.client.observe({ id: 'first', query })
    f.client.observe({ id: 'second', query })
    await vi.advanceTimersByTimeAsync(0)
    f.change()
    expect(vi.getTimerCount()).toBe(1)
    f.client.unobserve('first')
    expect(f.listeners.size).toBe(1)
    f.client.unobserve('second')
    f.client.unobserve('second')
    expect(f.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve(metrics())
    await vi.advanceTimersByTimeAsync(0)
    expect(f.updates).toEqual([{ id: 'first', snapshot: null }, { id: 'second', snapshot: null }])
  })

  it('allows synchronous cancellation before the first provider read starts', async () => {
    const f = fixture()
    f.client.observe({ id: 'first', query })
    f.client.unobserve('first')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.updates).toEqual([{ id: 'first', snapshot: null }])
    expect(f.listeners.size).toBe(0)
    expect(f.read).not.toHaveBeenCalled()
  })

  it('does not return a provider snapshot belonging to another source', async () => {
    const f = fixture()
    f.read.mockResolvedValueOnce(context)
    expect(await f.client.read(query)).toEqual({ source: 'task.metrics', status: 'unavailable', value: null })
  })

  it('ignores an old observation after the same ID is reused', async () => {
    const f = fixture()
    const pending = deferred()
    f.read.mockReturnValueOnce(pending.promise)
    f.client.observe({ id: 'same', query })
    await vi.advanceTimersByTimeAsync(0)
    f.client.unobserve('same')
    f.state.value = metrics(7)
    f.client.observe({ id: 'same', query })
    await vi.advanceTimersByTimeAsync(0)
    pending.resolve(metrics(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.updates).toEqual([{ id: 'same', snapshot: null }, { id: 'same', snapshot: metrics(7) }])
  })

  it('does not publish or read after disposal and clears all subscriptions and timers', async () => {
    const f = fixture()
    const pending = deferred()
    f.read.mockReturnValueOnce(pending.promise)
    f.client.observe({ id: 'first', query })
    const result = f.client.read(query)
    await vi.advanceTimersByTimeAsync(0)
    f.change()
    expect(vi.getTimerCount()).toBe(1)
    f.client.dispose()
    f.client.dispose()
    expect(f.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve(metrics(8))
    expect(await result).toEqual({ source: 'task.metrics', status: 'unavailable', value: null })
    f.client.unobserve('first')
    f.client.observe({ id: 'later', query })
    f.client.refresh()
    expect(await f.client.read(query)).toEqual({ source: 'task.metrics', status: 'unavailable', value: null })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.updates).toEqual([])
    expect(f.read).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown sources and scopes without accessing a provider', async () => {
    const f = fixture()
    await expect(f.client.read({ source: 'unknown', scope: 'bound' } as unknown as ExtensionDataQuery)).rejects.toThrow('Invalid')
    expect(() => f.client.observe({ id: 'bad', query: { source: 'task.metrics', scope: 'global' } as unknown as ExtensionDataQuery })).toThrow('Invalid')
    expect(f.listeners.size).toBe(0)
    expect(f.read).not.toHaveBeenCalled()
  })
})
