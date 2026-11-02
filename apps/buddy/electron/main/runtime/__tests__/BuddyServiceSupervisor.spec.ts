import type { BuddyRunEvent } from '../../../../service/src/events/BuddyRunEvent'
import type { ApplicationDiagnostic } from '../../../../shared/diagnostics/applicationDiagnostic'
import type { BuddyServiceMessageProcess } from '../BuddyServicePeer'
import type { BuddyServiceProcessInstance } from '../buddyServiceProcess'
import type { BuddyServiceSupervisorOptions } from '../BuddyServiceSupervisor'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { observeRunDiagnostics } from '../../../../service/src/events/observeRunDiagnostics'
import { APPLICATION_DIAGNOSTIC_METHOD } from '../../../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../../../shared/events/Emitter'
import { SERVICE_LIFECYCLE_METHOD } from '../../../../shared/lifecycle/serviceLifecycle'
import { ServiceLifecycleSource } from '../../../../shared/lifecycle/ServiceLifecycleSource'
import { ApplicationEvents } from '../../../../shared/observability/ApplicationEvents'
import { BUDDY_SERVICE_PROTOCOL_VERSION } from '../../../../shared/runtime/runtimeProtocol'
import { BuddyServicePeer } from '../BuddyServicePeer'
import { BuddyServiceSupervisor } from '../BuddyServiceSupervisor'

class FakeUtilityProcess extends EventEmitter implements BuddyServiceProcessInstance, BuddyServiceMessageProcess {
  readonly outbound: unknown[] = []
  readonly pid: number
  killed = false

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  postMessage(message: unknown): void {
    this.outbound.push(message)
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  notify(method: string, params: unknown): void {
    this.emit('message', { jsonrpc: '2.0', method, params })
  }

  respond(index: number, result: unknown): void {
    const request = this.outbound[index] as { id: string }
    this.emit('message', { id: request.id, jsonrpc: '2.0', result })
  }

  exit(code = 0): void {
    this.emit('exit', code)
  }
}

function createSupervisor(
  restartDelaysMs: number[] = [5],
  readiness: Pick<BuddyServiceSupervisorOptions, 'readinessTimeoutMs' | 'onDiagnostic'> = { readinessTimeoutMs: 100 },
) {
  const processes: FakeUtilityProcess[] = []
  const diagnostics: ApplicationDiagnostic[] = []
  const supervisor = new BuddyServiceSupervisor({
    onDiagnostic: event => diagnostics.push(event),
    diagnosticOutput: new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    }),
    forceKillTimeoutMs: 10,
    ...readiness,
    restartDelaysMs,
    shutdownTimeoutMs: 20,
    spawnService(onFatalError) {
      const process = new FakeUtilityProcess(1000 + processes.length)
      processes.push(process)
      return {
        peer: new BuddyServicePeer({ onFatalError, process }),
        process,
      }
    },
    stableResetMs: 60_000,
  })
  return { processes, supervisor, diagnostics }
}

describe('buddyServiceSupervisor utility process lifecycle', () => {
  it('binds trusted producer identities across runtime generations and preserves durable cursors', async () => {
    const forgedProducer = crypto.randomUUID()
    const { supervisor, processes, diagnostics } = createSupervisor([])
    for (const [index, revision] of [41, 73].entries()) {
      supervisor.start()
      const process = processes[index]!
      process.notify('runtime.ready', { protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION })
      const events = new ApplicationEvents({ producerInstanceId: forgedProducer })
      const commits = new Emitter<BuddyRunEvent>(() => {})
      events.subscribe(event => process.notify(APPLICATION_DIAGNOSTIC_METHOD, event))
      const diagnostics = observeRunDiagnostics({ onDidCommit: commits.event }, { findById: () => null }, events.publish)
      commits.fire({ runId: `run-${index}`, type: 'run.failed', sequence: revision, createdAt: new Date().toISOString(), payload: {} })
      const stopping = supervisor.stop()
      await new Promise(resolve => setImmediate(resolve))
      events.publish({ event: 'service.stopped', level: 'info' })
      process.exit()
      await stopping
      diagnostics.dispose()
      commits.dispose()
    }
    const failures = diagnostics.filter(record => record.event === 'run.failed')
    expect(failures).toMatchObject([
      { runId: 'run-0', sourceSequence: 1, revision: 41 },
      { runId: 'run-1', sourceSequence: 1, revision: 73 },
    ])
    expect(new Set(failures.map(record => record.producerInstanceId)).size).toBe(2)
    expect(failures.every(record => record.producerInstanceId && record.producerInstanceId !== forgedProducer)).toBe(true)
    for (const record of failures) {
      expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'service.stopped', producerInstanceId: record.producerInstanceId, sourceSequence: 2 }))
    }
  })

  it('keeps typed lifecycle snapshots independent of failed diagnostics and retires old generation state', async () => {
    const { processes, supervisor } = createSupervisor([], { onDiagnostic: () => {
      throw new Error('diagnostics unavailable')
    } })
    supervisor.onStateChange(() => {
      throw new Error('optional observer failed')
    })
    supervisor.start()
    const source = new ServiceLifecycleSource()
    source.reader.onDidChange(change => processes[0]!.notify(SERVICE_LIFECYCLE_METHOD, change))
    source.update({ component: 'runtime.database', kind: 'service', operationId: 'database-1', status: 'ready' })
    expect(supervisor.lifecycleState.services?.components[0]?.status).toBe('ready')
    source.update({ component: 'runtime.event_replay', kind: 'operation', operationId: 'recovery-1', status: 'starting' })
    source.updateProgress('runtime.event_replay', 'recovery-1', { completed: 2, total: 5 })
    expect(supervisor.lifecycleState.services?.components[1]).toMatchObject({ status: 'starting', progress: { completed: 2, total: 5 } })
    processes[0]!.notify('runtime.ready', { protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION })
    const firstGeneration = supervisor.lifecycleState.generation
    expect(firstGeneration).not.toBeNull()
    expect(supervisor.lifecycleState.status).toBe('ready')
    const stopping = supervisor.stop()
    await new Promise(resolve => setImmediate(resolve))
    source.update({ component: 'runtime.database', kind: 'service', operationId: 'database-1', status: 'stopped' })
    expect(supervisor.lifecycleState.services?.components[0]?.status).toBe('ready')
    processes[0]!.exit()
    await stopping
    expect(supervisor.lifecycleState.status).toBe('stopped')
    supervisor.start()
    expect(supervisor.lifecycleState).toMatchObject({ generation: expect.any(String), services: null, status: 'starting' })
    expect(supervisor.lifecycleState.generation).not.toBe(firstGeneration)
    const stopped = supervisor.stop()
    await new Promise(resolve => setImmediate(resolve))
    processes[1]!.exit()
    await stopped
  })
  it('waits through slow initialization for versioned readiness and shuts down gracefully', async () => {
    vi.useFakeTimers()
    try {
      const { processes, supervisor, diagnostics } = createSupervisor([], {})
      const notifications: unknown[] = []
      supervisor.onNotification(notification => notifications.push(notification))
      supervisor.start()
      const process = processes[0]!
      const pending = supervisor.request('runtime.status', {})
      await vi.advanceTimersByTimeAsync(35_000)
      expect(supervisor.state.status).toBe('starting')
      expect(process.killed).toBe(false)
      expect(process.outbound).toEqual([])
      process.notify('run.event', { runId: 'recovery-run' })
      expect(supervisor.notify('scheduler.wake', { reason: 'resume' })).toBe(false)

      process.notify('runtime.ready', { protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION })
      await vi.advanceTimersByTimeAsync(0)
      expect(supervisor.state.status).toBe('ready')
      expect(process.outbound).toHaveLength(1)
      process.respond(0, { ready: true })
      await expect(pending).resolves.toEqual({ ready: true })
      process.notify('run.event', { runId: 'run-1' })
      expect(notifications).toEqual([{ method: 'run.event', params: { runId: 'run-1' } }])
      expect(supervisor.notify('scheduler.wake', { reason: 'unlock-screen' })).toBe(true)
      expect(process.outbound.at(-1)).toEqual({
        jsonrpc: '2.0',
        method: 'scheduler.wake',
        params: { reason: 'unlock-screen' },
      })

      const stopping = supervisor.stop()
      await vi.advanceTimersByTimeAsync(0)
      expect(process.outbound.at(-1)).toMatchObject({ method: 'runtime.shutdown' })
      process.respond(process.outbound.length - 1, { accepted: true })
      process.exit()
      await stopping
      expect(supervisor.state.status).toBe('stopped')
      expect(process.killed).toBe(false)
      expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'runtime.exited', processExit: { type: 'utility', reason: 'clean-exit', code: 0, expected: true } }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('terminates a runtime that never becomes ready after the bounded cold-start budget', async () => {
    vi.useFakeTimers()
    try {
      const { processes, supervisor } = createSupervisor([], {})
      supervisor.start()
      const rejected = expect(supervisor.request('runtime.status', {})).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
      await vi.advanceTimersByTimeAsync(119_999)
      expect(processes[0]!.killed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(processes[0]!.killed).toBe(true)
      processes[0]!.exit(1)
      await vi.advanceTimersByTimeAsync(0)
      await rejected
      expect(supervisor.state).toMatchObject({ status: 'offline', lastError: 'RUNTIME_READINESS_TIMEOUT' })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('accepts startup events before readiness and rejects diagnostic payload details', async () => {
    const { processes, supervisor, diagnostics } = createSupervisor()
    supervisor.start()
    processes[0]!.notify(APPLICATION_DIAGNOSTIC_METHOD, { event: 'component.starting', component: 'runtime.database', level: 'info', operationId: 'database-1' })
    processes[0]!.notify(APPLICATION_DIAGNOSTIC_METHOD, { event: 'run.failed', level: 'error', runId: 'run-1', conversationId: 'conversation-1' })
    processes[0]!.notify(APPLICATION_DIAGNOSTIC_METHOD, { event: 'run.failed', level: 'error', payload: { prompt: 'private' } })
    expect(supervisor.state.status).toBe('starting')
    expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'component.starting', component: 'runtime.database', operationId: 'database-1' }))
    expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'run.failed', runId: 'run-1', conversationId: 'conversation-1', sourceId: 'runtime-1', sourcePid: 1000 }))
    expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'runtime.diagnostic_invalid' }))
    expect(JSON.stringify(diagnostics)).not.toContain('private')
    const stopping = supervisor.stop()
    await new Promise(resolve => setImmediate(resolve))
    processes[0]!.notify(APPLICATION_DIAGNOSTIC_METHOD, { event: 'service.stopped', level: 'info' })
    processes[0]!.exit()
    await stopping
    expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'service.stopped', sourceId: 'runtime-1' }))
  })
  it('preserves a stable startup failure after bounded restart is exhausted', async () => {
    vi.useFakeTimers()
    try {
      const { processes, supervisor } = createSupervisor([5])
      supervisor.start()
      processes[0]!.notify('runtime.failed', { code: 'RUNTIME_START_FAILED' })
      await vi.advanceTimersByTimeAsync(0)
      expect(processes[0]!.killed).toBe(true)
      processes[0]!.exit(1)

      await vi.advanceTimersByTimeAsync(5)
      expect(processes).toHaveLength(2)
      processes[1]!.notify('runtime.failed', { code: 'RUNTIME_START_FAILED' })
      await vi.advanceTimersByTimeAsync(0)
      expect(processes[1]!.killed).toBe(true)
      processes[1]!.exit(1)
      await vi.advanceTimersByTimeAsync(0)

      expect(supervisor.state).toEqual({
        lastError: 'RUNTIME_START_FAILED',
        pid: null,
        restartAttempt: 1,
        status: 'offline',
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('keeps a corrupted event log offline until a manual restart', async () => {
    vi.useFakeTimers()
    try {
      const { processes, supervisor } = createSupervisor([5])
      supervisor.start()

      processes[0]!.notify('runtime.failed', { code: 'EVENT_LOG_CORRUPTED' })
      await vi.advanceTimersByTimeAsync(0)
      expect(processes[0]!.killed).toBe(true)
      expect(supervisor.state).toEqual({
        lastError: 'EVENT_LOG_CORRUPTED',
        pid: processes[0]!.pid,
        restartAttempt: 0,
        status: 'stopping',
      })
      processes[0]!.exit(1)
      await vi.advanceTimersByTimeAsync(0)

      expect(supervisor.state).toEqual({
        lastError: 'EVENT_LOG_CORRUPTED',
        pid: null,
        restartAttempt: 0,
        status: 'offline',
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(processes).toHaveLength(1)
      supervisor.start()
      expect(processes).toHaveLength(2)
      expect(supervisor.state).toEqual({
        lastError: null,
        pid: processes[1]!.pid,
        restartAttempt: 0,
        status: 'starting',
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('takes an incompatible protocol offline without scheduling a restart', async () => {
    vi.useFakeTimers()
    try {
      const { processes, supervisor } = createSupervisor([5])
      supervisor.start()

      processes[0]!.notify('runtime.ready', {
        protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION + 1,
      })
      await vi.advanceTimersByTimeAsync(0)
      processes[0]!.exit(1)
      await vi.advanceTimersByTimeAsync(0)

      expect(supervisor.state).toEqual({
        lastError: 'RUNTIME_PROTOCOL_INCOMPATIBLE',
        pid: null,
        restartAttempt: 0,
        status: 'offline',
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(processes).toHaveLength(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('refuses to replace a runtime generation that could not be terminated', async () => {
    vi.useFakeTimers()
    try {
      const { processes, supervisor } = createSupervisor([5])
      supervisor.start()
      processes[0]!.notify('runtime.failed', { code: 'EVENT_LOG_CORRUPTED' })

      await vi.advanceTimersByTimeAsync(10)
      expect(supervisor.state).toEqual({
        lastError: 'RUNTIME_TERMINATION_FAILED',
        pid: processes[0]!.pid,
        restartAttempt: 0,
        status: 'offline',
      })

      await expect(supervisor.restart()).rejects.toMatchObject({
        code: 'RUNTIME_UNAVAILABLE',
      })
      await vi.advanceTimersByTimeAsync(100)

      expect(processes).toHaveLength(1)
      expect(supervisor.state).toEqual({
        lastError: 'RUNTIME_TERMINATION_FAILED',
        pid: processes[0]!.pid,
        restartAttempt: 0,
        status: 'offline',
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('treats an invalid failure notification as a protocol failure', async () => {
    vi.useFakeTimers()
    try {
      const { processes, supervisor } = createSupervisor([])
      supervisor.start()

      processes[0]!.notify('runtime.failed', {
        code: 'RAW_FILESYSTEM_ERROR',
        detail: '/private/path',
      })
      await vi.advanceTimersByTimeAsync(0)
      processes[0]!.exit(1)
      await vi.advanceTimersByTimeAsync(0)

      expect(supervisor.state).toEqual({
        lastError: 'RUNTIME_PROTOCOL_FAILED',
        pid: null,
        restartAttempt: 0,
        status: 'offline',
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('uses bounded restart after an unexpected exit', async () => {
    vi.useFakeTimers()
    const { processes, supervisor } = createSupervisor([5])
    supervisor.start()
    processes[0]!.exit(1)
    expect(supervisor.state.status).toBe('restarting')

    await vi.advanceTimersByTimeAsync(5)
    expect(processes).toHaveLength(2)
    vi.useRealTimers()
  })

  it('keeps the same Runtime available when it becomes busy before backup shutdown', async () => {
    const { processes, supervisor } = createSupervisor()
    supervisor.start()
    const process = processes[0]!
    process.notify('runtime.ready', { protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION })
    let copied = false
    const backup = supervisor.withStoppedStorage(async () => {
      copied = true
    })
    const rejected = expect(backup).rejects.toThrow('SNAPSHOT_RUNTIME_BUSY')
    await new Promise(resolve => setImmediate(resolve))
    expect(supervisor.state.status).toBe('ready')
    expect(process.outbound[0]).toMatchObject({ method: 'runtime.shutdown', params: { onlyIfIdle: true } })
    process.respond(0, { accepted: false })
    await rejected
    expect(copied).toBe(false)
    expect(process.killed).toBe(false)
    expect(processes).toHaveLength(1)
    expect(supervisor.lifecycleState).toMatchObject({ status: 'ready', maintenance: null })
    const request = supervisor.request('runs.isBusy', {})
    await new Promise(resolve => setImmediate(resolve))
    process.respond(1, true)
    expect(await request).toBe(true)
    const stopping = supervisor.stop()
    await new Promise(resolve => setImmediate(resolve))
    process.exit()
    await stopping
  })

  it.each([false, true])('labels a confirmed idle backup and restores Runtime after snapshot failure=%s', async (fail) => {
    const { processes, supervisor } = createSupervisor()
    supervisor.start()
    const process = processes[0]!
    process.notify('runtime.ready', { protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION })
    const gate = Promise.withResolvers<void>()
    let copied = false
    const backup = supervisor.withStoppedStorage(async () => {
      copied = true
      await gate.promise
      if (fail)
        throw new Error('SNAPSHOT_FAILED')
      return 'snapshot'
    })
    const completion = fail ? expect(backup).rejects.toThrow('SNAPSHOT_FAILED') : expect(backup).resolves.toBe('snapshot')
    await new Promise(resolve => setImmediate(resolve))
    expect(copied).toBe(false)
    process.respond(0, { accepted: true })
    await new Promise(resolve => setImmediate(resolve))
    expect(supervisor.lifecycleState).toMatchObject({ status: 'stopping', maintenance: 'backup' })
    expect(copied).toBe(false)
    process.exit()
    await new Promise(resolve => setImmediate(resolve))
    expect(copied).toBe(true)
    expect(supervisor.lifecycleState).toMatchObject({ status: 'stopped', maintenance: 'backup' })
    gate.resolve()
    await completion
    expect(processes).toHaveLength(2)
    processes[1]!.notify('runtime.ready', { protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION })
    expect(supervisor.lifecycleState).toMatchObject({ status: 'ready', maintenance: null })
    const stopping = supervisor.stop()
    await new Promise(resolve => setImmediate(resolve))
    processes[1]!.exit()
    await stopping
  })
})
