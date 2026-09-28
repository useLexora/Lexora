import { describe, expect, it } from 'vitest'
import { Emitter, filterEvent } from '../Emitter'
import { copyEventSnapshot } from '../eventSnapshot'

describe('service events', () => {
  it('delivers reentrant facts in source order with emission-time listener membership', () => {
    const emitter = new Emitter<number>(() => {})
    const seen: string[] = []
    emitter.event((value) => {
      seen.push(`first:${value}`)
      if (value === 1) {
        emitter.fire(2)
        emitter.event(value => seen.push(`late:${value}`))
      }
    })
    emitter.event(value => seen.push(`second:${value}`))
    emitter.fire(1)
    emitter.fire(3)
    expect(seen).toEqual(['first:1', 'second:1', 'first:2', 'second:2', 'first:3', 'second:3', 'late:3'])
  })

  it('isolates synchronous, asynchronous and error-handler failures without losing siblings', async () => {
    const errors: unknown[] = []
    const emitter = new Emitter<number>((error) => {
      errors.push(error)
      throw new Error('sink unavailable')
    })
    const seen: number[] = []
    emitter.event(() => {
      throw new Error('sync')
    })
    emitter.event(async () => {
      throw new Error('async')
    })
    emitter.event(value => seen.push(value))
    expect(() => emitter.fire(1)).not.toThrow()
    await Promise.resolve()
    expect(seen).toEqual([1])
    expect(errors).toHaveLength(2)
  })

  it('owns duplicate subscriptions, aborts queued deliveries and removes once before reentry', () => {
    const emitter = new Emitter<number>(() => {})
    const seen: number[] = []
    const listener = (value: number) => seen.push(value)
    const first = emitter.event(listener)
    const controller = new AbortController()
    emitter.event((value) => {
      if (value === 1) {
        emitter.fire(2)
        controller.abort()
      }
    }, { once: true })
    emitter.event(listener, { signal: controller.signal })
    first.dispose()
    emitter.fire(1)
    emitter.fire(3)
    expect(seen).toEqual([])
    emitter.dispose()
    emitter.event(listener)
    emitter.fire(4)
    expect(seen).toEqual([])
  })

  it('applies once to the selected event and freezes independent event-time snapshots', () => {
    const emitter = new Emitter<number>(() => {})
    const seen: number[] = []
    filterEvent(emitter.event, value => value > 1)(value => seen.push(value), { once: true })
    emitter.fire(1)
    emitter.fire(2)
    emitter.fire(3)
    expect(seen).toEqual([2])
    const value = { nested: { ids: ['a'] }, callback: () => 'accepted' }
    const snapshot = copyEventSnapshot(value)
    value.nested.ids.push('b')
    expect(snapshot.nested.ids).toEqual(['a'])
    expect(() => (snapshot.nested.ids as string[]).push('c')).toThrow()
    expect(snapshot.callback()).toBe('accepted')
  })
})
