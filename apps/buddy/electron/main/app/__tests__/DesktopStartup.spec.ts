import type { ApplicationDiagnostic } from '../../../../shared/diagnostics/applicationDiagnostic'
import { describe, expect, it } from 'vitest'
import { PrivateDirectoryError } from '../../../../platform/windows/privateDirectories'
import { ServiceHost } from '../../../../shared/lifecycle/ServiceHost'
import { ApplicationEvents } from '../../../../shared/observability/ApplicationEvents'
import { observeLifecycleDiagnostics } from '../../../../shared/observability/lifecycleDiagnostics'
import { DesktopStartup } from '../DesktopStartup'
import { observeStartupDiagnostics } from '../startupDiagnostics'
import { createStartupFixture } from './startupFixture'

function fixture() {
  const state = createStartupFixture()
  const events: ApplicationDiagnostic[] = []
  const publisher = new ApplicationEvents()
  publisher.subscribe(event => events.push(event))
  const stopDiagnostics = observeStartupDiagnostics(state.startup, publisher)
  return { ...state, events, stopDiagnostics }
}

describe('application lifecycle snapshot', () => {
  it('retains the first failure and its operation without relabeling cleanup as cancellation', async () => {
    const events = new ApplicationEvents()
    const records: ApplicationDiagnostic[] = []
    const startup = new DesktopStartup()
    const host = new ServiceHost()
    events.subscribe(event => records.push(event))
    observeStartupDiagnostics(startup, events)
    observeLifecycleDiagnostics(host.lifecycle, events)
    startup.bindDesktop(host.lifecycle)
    const error = new PrivateDirectoryError('PRIVATE_DIRECTORIES_UNSAFE', { kind: 'private_directories', operation: 'validate_acl', directoryRole: 'session_data', exitCode: 1 })
    await expect(host.start('desktop', () => host.step('desktop.environment', () => {
      throw error
    }))).rejects.toBe(error)
    startup.failed(error)
    startup.stopping()
    await host.stop()
    startup.stopped()
    const operation = records.find(record => record.event === 'startup.step.failed')!
    expect(records.filter(record => record.event === 'app.start_failed')).toEqual([
      expect.objectContaining({ component: 'desktop.environment', parentOperationId: operation.operationId, errorCode: error.code, failure: error.failure }),
    ])
    expect(records.some(record => record.event === 'app.start_cancelled')).toBe(false)
    expect(startup.state.status).toBe('stopped')
  })

  it('reports a failure outside a managed operation once', () => {
    const { startup, events } = fixture()
    startup.failed(Object.assign(new Error('fixture-private-path'), { code: 'EACCES' }))
    startup.failed(new Error('subsequent failure'))
    startup.stopping()
    expect(events.filter(event => event.event === 'app.start_failed')).toEqual([expect.objectContaining({ errorCode: 'EACCES' })])
    expect(events.some(event => event.event === 'app.start_cancelled')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('fixture-private')
  })

  it('reports an actual startup cancellation once and ignores delayed completion', () => {
    const { startup, events, complete } = fixture()
    startup.stopping()
    startup.stopping()
    complete('desktop')
    expect(events.filter(event => event.event === 'app.start_cancelled')).toHaveLength(1)
    expect(events.some(event => event.event === 'app.start_failed' || event.event === 'app.ready')).toBe(false)
  })

  it('waits for renderer hydration, recovers, and publishes readiness once', () => {
    const { startup, events, complete, send, connect } = fixture()
    complete('desktop')
    connect('runtime-1')
    send('renderer', 'starting')
    send('renderer.providers', 'starting')
    send('renderer.providers', 'start_failed')
    expect(startup.state.status).toBe('failed')
    expect(startup.state.hasBeenReady).toBe(false)
    complete('renderer')
    expect(startup.state.status).toBe('ready')
    expect(startup.state.hasBeenReady).toBe(true)
    expect(events.filter(event => event.event === 'app.ready')).toHaveLength(1)
    const snapshot = startup.state
    Object.assign(snapshot.stages[0]!, { status: 'failed' })
    expect(startup.state.stages[0]?.status).toBe('completed')
  })

  it('rejects delayed renderer reports after the Runtime generation changes while retaining their diagnostics', () => {
    const { startup, complete, connect, events } = fixture()
    complete('desktop')
    connect('runtime-1')
    complete('renderer')
    connect('runtime-2', 'starting')
    const revision = startup.state.revision
    complete('renderer', 'runtime-1')
    expect(startup.state.status).toBe('starting')
    expect(startup.state.revision).toBe(revision)
    expect(events).toContainEqual(expect.objectContaining({ event: 'component.ready', component: 'renderer', generation: 'runtime-1' }))
    connect('runtime-2')
    complete('renderer', 'runtime-2')
    expect(startup.state.status).toBe('ready')
  })

  it('does not announce readiness after shutdown has begun', () => {
    const { startup, events, complete, connect } = fixture()
    complete('desktop')
    connect('runtime-1')
    startup.stopping()
    complete('renderer')
    expect(startup.state.status).toBe('stopping')
    expect(events.some(event => event.event === 'app.ready')).toBe(false)
  })

  it('becomes ready without diagnostics and preserves observation after a consumer fails', () => {
    const { startup, complete, connect, stopDiagnostics, events } = fixture()
    stopDiagnostics()
    startup.onStateChange(() => {
      throw new Error('optional view failed')
    })
    complete('desktop')
    connect('runtime-1')
    complete('renderer')
    expect(startup.state.status).toBe('ready')
    connect('runtime-2', 'starting')
    connect('runtime-2')
    complete('renderer', 'runtime-2')
    expect(startup.reconcile().status).toBe('ready')
    expect(events).toEqual([])
  })

  it('reconstructs completed managed stages when subscribed after initialization', async () => {
    const host = new ServiceHost()
    await host.start('desktop', () => true)
    const startup = new DesktopStartup()
    startup.bindDesktop(host.lifecycle)
    expect(startup.state.stages).toContainEqual(expect.objectContaining({ stage: 'desktop', status: 'completed' }))
  })
})
