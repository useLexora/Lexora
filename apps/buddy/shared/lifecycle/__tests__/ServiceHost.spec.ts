import type { ApplicationDiagnostic } from '../../diagnostics/applicationDiagnostic'
import type { LifecycleProgress } from '../serviceLifecycle'
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
  observeLifecycleDiagnostics(host.lifecycle, events)
  return { records, host }
}

describe('managed component lifecycle', () => {
  it('unwinds partial startup and continues cleanup after a failure', async () => {
    const { host, records } = fixture()
    const cleaned: string[] = []
    await expect(host.start('runtime.database', ({ defer }) => {
      defer(() => {
        cleaned.push('database')
      })
      return false
    })).resolves.toBe(false)
    expect(host.lifecycle.snapshot.components[0]?.status).toBe('ready')
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
    await expect(host.start('desktop.late', () => true)).rejects.toThrow('stopping')
    expect(disposed).toBe(1)
    expect(records.some(record => record.event === 'component.ready')).toBe(false)
    expect(records.at(-1)?.event).toBe('component.stopped')
  })

  it('publishes immutable bounded progress without repeating lifecycle transitions or accepting late updates', async () => {
    const { host, records } = fixture()
    let reportProgress!: (progress: LifecycleProgress) => void
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const operation = host.step('runtime.event_replay', async (scope) => {
      reportProgress = scope.reportProgress
      reportProgress({ completed: 0, total: 3 })
      await gate
    })
    await Promise.resolve()
    const initial = host.lifecycle.snapshot
    reportProgress({ completed: 1, total: 3 })
    const current = host.lifecycle.snapshot
    expect(initial.components[0]?.progress).toEqual({ completed: 0, total: 3 })
    expect(current.components[0]).toMatchObject({ status: 'starting', progress: { completed: 1, total: 3 } })
    reportProgress({ completed: 1, total: 3 })
    expect(host.lifecycle.snapshot.revision).toBe(current.revision)
    expect(() => reportProgress({ completed: 4, total: 3 })).toThrow()
    expect(() => Object.assign(current.components[0]!.progress!, { completed: 2 })).toThrow()
    finish()
    await operation
    const ready = host.lifecycle.snapshot
    reportProgress({ completed: 3, total: 3 })
    expect(host.lifecycle.snapshot).toBe(ready)
    expect(ready.components[0]).toMatchObject({ status: 'ready' })
    expect(records.map(record => record.event)).toEqual(['startup.step.started', 'startup.step.completed'])
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
