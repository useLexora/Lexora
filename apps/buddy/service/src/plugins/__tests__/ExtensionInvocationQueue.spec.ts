import { describe, expect, it } from 'vitest'
import { ExtensionInvocationQueue } from '../ExtensionInvocationQueue'

describe('extension invocation admission', () => {
  it('keeps the global execution and waiting bounds and reuses cancelled queue capacity', async () => {
    const queue = new ExtensionInvocationQueue()
    const stop = new AbortController()
    const active = await Promise.all(Array.from({ length: 32 }, (_, index) => queue.acquire(`plugin-${index}`, `active-${index}`, stop.signal)))
    let admitted = 0
    const waiting = Promise.allSettled(Array.from({ length: 1024 }, (_, index) => queue.acquire('plugin-0', `waiting-${index}`, stop.signal).then((release) => {
      admitted++
      return release
    })))
    await expect(queue.acquire('plugin-0', 'overflow', stop.signal)).rejects.toThrow('EXTENSION_REQUEST_LIMIT')
    await expect(queue.acquire('plugin-1', 'active-0', stop.signal)).rejects.toThrow('EXTENSION_REQUEST_LIMIT')
    expect(admitted).toBe(0)
    active[0]!()
    await Promise.resolve()
    expect(admitted).toBe(1)
    stop.abort()
    const results = await waiting
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1023)
    for (const result of results) {
      if (result.status === 'fulfilled')
        result.value()
    }
    for (const release of active) release()
    const release = await queue.acquire('plugin-0', 'waiting-1', new AbortController().signal)
    release()
  })
})
