import { describe, expect, expectTypeOf, it } from 'vitest'
import { EventBus } from '../EventBus'

interface Events {
  'message': string
  'configuration:changed': { enabled: boolean }
  'workbench:panes:changed': number
  'workbench:visible': boolean
}
function fail(error: unknown) {
  throw error
}

describe('scoped event bus', () => {
  it('delivers reentrant facts in FIFO order with event-time snapshots', () => {
    const bus = new EventBus<Events>(fail)
    const seen: string[] = []
    bus.on('message', ({ data }) => {
      seen.push(`first:${data}`)
      if (data === 'outer')
        bus.emit({ type: 'message', data: 'inner' })
    })
    bus.on('message', ({ data }) => seen.push(`second:${data}`))
    bus.emit({ type: 'message', data: 'outer' })
    expect(seen).toEqual(['first:outer', 'second:outer', 'first:inner', 'second:inner'])
  })

  it('matches exact, single-level and recursive namespaces without delivering to other scopes', async () => {
    const bus = new EventBus<Events>(fail)
    const other = new EventBus<Events>(fail)
    const seen: string[] = []
    bus.on('*', event => seen.push(`root:${event.type}`))
    bus.on('workbench:*', (event) => {
      expectTypeOf(event.data).toEqualTypeOf<boolean>()
      seen.push(`child:${event.type}`)
    })
    bus.on('workbench:**', event => seen.push(`tree:${event.type}`))
    bus.on('configuration:changed', (event) => {
      expectTypeOf(event.data).toEqualTypeOf<{ enabled: boolean }>()
      seen.push(`config:${event.data.enabled}`)
    })
    bus.on('**', event => seen.push(`all:${event.type}`))
    expect(other.emit({ type: 'configuration:changed', data: { enabled: false } })).toBe(false)
    expect(await other.emit({ type: 'message', data: 'none' })).toBe(false)
    expect(bus.emit({ type: 'message', data: 'hello' })).toBe(true)
    bus.emit({ type: 'workbench:visible', data: true })
    bus.emit({ type: 'workbench:panes:changed', data: 2 })
    await bus.emit({ type: 'configuration:changed', data: { enabled: true } })
    expect(seen.sort()).toEqual([
      'root:message',
      'all:message',
      'child:workbench:visible',
      'tree:workbench:visible',
      'all:workbench:visible',
      'tree:workbench:panes:changed',
      'all:workbench:panes:changed',
      'config:true',
      'all:configuration:changed',
    ].sort())
    bus.dispose()
    expect(bus.hasListeners('message')).toBe(false)
  })

  it('owns duplicate registrations independently and removes once subscriptions before reentrant delivery', () => {
    const bus = new EventBus<Events>(fail)
    const seen: string[] = []
    const listener = () => seen.push('same')
    const first = bus.on('message', listener)
    const second = bus.on('message', listener)
    first.dispose()
    first.dispose()
    bus.emit({ type: 'message', data: 'first' })
    second.dispose()
    bus.on('message', () => {
      seen.push('once')
      bus.emit({ type: 'message', data: 'nested' })
    }, { once: true })
    bus.emit({ type: 'message', data: 'second' })
    expect(seen).toEqual(['same', 'once'])
    expect(bus.hasListeners('message')).toBe(false)
  })

  it('snapshots deliveries, skips removed listeners and releases abort-bound or disposed subscriptions', () => {
    const bus = new EventBus<Events>(fail)
    const seen: string[] = []
    const abort = new AbortController()
    bus.on('message', () => {
      bus.on('message', () => seen.push('next'))
      abort.abort()
    }, { once: true })
    bus.on('message', () => seen.push('removed'), { signal: abort.signal })
    bus.emit({ type: 'message', data: 'first' })
    expect(seen).toEqual([])
    bus.on('message', () => seen.push('already-aborted'), { signal: abort.signal })
    bus.emit({ type: 'message', data: 'next' })
    expect(seen).toEqual(['next'])
    bus.dispose()
    expect(bus.emit({ type: 'message', data: 'disposed' })).toBe(false)
    expect(() => bus.on('message', () => {})).toThrow('EVENT_BUS_DISPOSED')
  })

  it('isolates sync and async observer failures', async () => {
    const errors: string[] = []
    const bus = new EventBus<Events>((_error, event) => errors.push(event.type))
    const seen: string[] = []
    bus.on('message', () => {
      throw new Error('private sync failure')
    })
    bus.on('message', async () => {
      throw new Error('private async failure')
    })
    bus.on('message', () => seen.push('completed'))
    expect(bus.emit({ type: 'message', data: 'notify' })).toBe(true)
    await Promise.resolve()
    expect(errors).toEqual(['message', 'message'])
  })

  it('composes typed arrays with overlap deduplication and a shared once, abort and disposal lifetime', async () => {
    const bus = new EventBus<Events>(fail)
    const seen: string[] = []
    const abort = new AbortController()
    const group = bus.on(['configuration:*', 'configuration:changed', 'message'], (event) => {
      if (event.type === 'configuration:changed') {
        expectTypeOf(event.data).toEqualTypeOf<{ enabled: boolean }>()
        seen.push(`config:${event.data.enabled}`)
      }
      else {
        expectTypeOf(event.data).toEqualTypeOf<string>()
        seen.push(event.data)
      }
    }, { signal: abort.signal })
    bus.emit({ type: 'configuration:changed', data: { enabled: true } })
    await bus.emit({ type: 'message', data: 'async' })
    abort.abort()
    group.dispose()
    expect(bus.hasListeners('configuration:changed')).toBe(false)
    bus.on(['message', 'workbench:**', 'workbench:visible'], () => {
      seen.push('once')
      bus.emit({ type: 'message', data: 'reentrant' })
    }, { once: true })
    await bus.emit({ type: 'workbench:visible', data: true })
    expect(seen).toEqual(['config:true', 'async', 'once'])
    expect(bus.hasListeners('message')).toBe(false)
    expect(bus.hasListeners('workbench:panes:changed')).toBe(false)
    bus.on([], fail)
    // @ts-expect-error Invalid patterns cannot partially install the group.
    expect(() => bus.on(['message', 'bad:*:pattern'], fail)).toThrow('EVENT_PATTERN_INVALID')
    expect(bus.hasListeners('message')).toBe(false)
  })
})
