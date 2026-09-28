import type { ApplicationDiagnostic } from '../../diagnostics/applicationDiagnostic'
import { describe, expect, it } from 'vitest'
import { ApplicationEvents } from '../../observability/ApplicationEvents'
import { observeLifecycleDiagnostics } from '../../observability/lifecycleDiagnostics'
import { ServiceHost } from '../ServiceHost'

function fixture() {
  const records: ApplicationDiagnostic[] = []
  const events = new ApplicationEvents()
  events.subscribe((event) => {
    records.push(event)
  })
  const host = new ServiceHost()
  const stopDiagnostics = observeLifecycleDiagnostics(host.lifecycle, events)
  return { records, events, host, stopDiagnostics }
}

describe('managed component lifecycle', () => {
  it('unwinds partial startup and continues cleanup after a failure', async () => {
    const { host, records } = fixture()
    const cleaned: string[] = []
    await host.start('runtime.database', ({ defer }) => {
      defer(() => {
        cleaned.push('database')
      })
    })
    await expect(host.start('runtime.rpc', ({ defer }) => {
      defer(() => {
        cleaned.push('rpc')
      })
      defer(() => {
        throw new Error('private cleanup detail')
      })
      throw new Error('private startup detail')
    }, ['runtime.database'])).rejects.toThrow('private startup')
    await expect(host.stop()).rejects.toThrow('cleanup failed')
    expect(cleaned).toEqual(['rpc', 'database'])
    expect(records.map(record => record.event)).toContain('component.stop_failed')
    expect(records.at(-1)).toMatchObject({ component: 'runtime.database', event: 'component.stopped' })
    expect(JSON.stringify(records)).not.toContain('private')
  })

  it('does not infer business failure from a false result or a broken observer', async () => {
    const { host, records, events } = fixture()
    events.subscribe(() => {
      throw new Error('sink failed')
    })
    events.subscribe(async () => {
      throw new Error('async sink failed')
    })
    await expect(host.start('desktop.feature', () => false)).resolves.toBe(false)
    expect(records.at(-1)?.event).toBe('component.ready')
    await host.stop()
    await expect(host.start('desktop.late', () => true)).rejects.toThrow('stopping')
  })

  it('waits for acquisition during stop, cleans it once, and never publishes late ready', async () => {
    const { host, records } = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let disposed = 0
    const opening = host.start('runtime.pending', async ({ defer }) => {
      await gate
      defer(() => {
        disposed += 1
      })
    })
    const stopping = host.stop()
    release()
    await opening
    await stopping
    await host.stop()
    expect(disposed).toBe(1)
    expect(records.some(record => record.event === 'component.ready')).toBe(false)
    expect(records.at(-1)?.event).toBe('component.stopped')
  })

  it('keeps an immutable current snapshot after diagnostic collection stops', async () => {
    const { host, stopDiagnostics, records } = fixture()
    await host.start('desktop.feature', () => true)
    stopDiagnostics()
    const before = host.lifecycle.snapshot
    expect(() => Object.assign(before.components[0]!, { status: 'failed' })).toThrow()
    await host.stop()
    expect(host.lifecycle.snapshot.components[0]?.status).toBe('stopped')
    expect(before.components[0]?.status).toBe('ready')
    expect(records.at(-1)?.event).toBe('component.ready')
  })

  it('isolates observers and waits for resources when an observer requests stop during registration', async () => {
    const host = new ServiceHost()
    let stopping: Promise<void> | undefined
    let cleanups = 0
    const states: string[] = []
    host.lifecycle.onDidChange(() => {
      throw new Error('observer failed')
    })
    host.lifecycle.onDidChange(({ component }) => {
      if (component)
        states.push(component.status)
      if (component?.status === 'registered')
        stopping = host.stop()
    })
    await host.start('desktop.feature', ({ defer }) => {
      defer(() => {
        cleanups += 1
      })
    })
    await stopping
    expect(cleanups).toBe(1)
    expect(states).toEqual(['registered', 'starting', 'stopping', 'stopped'])
    expect(host.lifecycle.snapshot.components[0]?.status).toBe('stopped')
  })
})
