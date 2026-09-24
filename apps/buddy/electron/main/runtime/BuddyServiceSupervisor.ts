import type { Writable } from 'node:stream'
import type { ApplicationDiagnostic } from '../../../shared/diagnostics/applicationDiagnostic'
import type { BuddyServiceSupervisorFailureCode } from '../../../shared/runtime/runtimeProtocol'
import type { BuddyServicePeer } from './BuddyServicePeer'
import type { BuddyServiceProcessHandle, BuddyServiceProcessInstance } from './buddyServiceProcess'
import process from 'node:process'
import { APPLICATION_DIAGNOSTIC_METHOD, applicationDiagnosticSchema } from '../../../shared/diagnostics/applicationDiagnostic'
import {
  BUDDY_SERVICE_PROTOCOL_VERSION,
  buddyServiceFailureNotificationSchema,
} from '../../../shared/runtime/runtimeProtocol'

export type BuddyServiceSupervisorStatus
  = | 'stopped'
    | 'starting'
    | 'ready'
    | 'restarting'
    | 'offline'
    | 'stopping'

export interface BuddyServiceSupervisorState {
  status: BuddyServiceSupervisorStatus
  pid: number | null
  restartAttempt: number
  lastError: BuddyServiceSupervisorFailureCode | null
}

export interface BuddyServiceNotification {
  method: string
  params: unknown
}

export interface BuddyServiceRequestOptions {
  requestId?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface BuddyServiceSupervisorOptions {
  onDiagnostic?: (event: ApplicationDiagnostic & { sourceId: string, sourcePid?: number }) => void
  bindPeer?: (peer: BuddyServicePeer) => (() => void) | void
  diagnosticOutput?: Writable
  forceKillTimeoutMs?: number
  readinessTimeoutMs?: number
  restartDelaysMs?: number[]
  shutdownTimeoutMs?: number
  spawnService: (onFatalError: (error: Error) => void, sourceId: string) => BuddyServiceProcessHandle
  stableResetMs?: number
}

interface ServiceGeneration extends BuddyServiceProcessHandle {
  disposeBinding: () => void
  id: number
  ready: boolean
  terminationRequested: boolean
}

const DEFAULT_RESTART_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000]
const DEFAULT_STABLE_RESET_MS = 60_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 2_000
const DEFAULT_READINESS_TIMEOUT_MS = 120_000
const RUNTIME_FAILURE_DISPOSITIONS = {
  EVENT_LOG_CORRUPTED: 'offline',
  EVENT_PROJECTION_FAILED: 'offline',
  EVENT_STORAGE_FAILED: 'offline',
  RUNTIME_PROTOCOL_FAILED: 'offline',
  RUNTIME_PROTOCOL_INCOMPATIBLE: 'offline',
  RUNTIME_READINESS_TIMEOUT: 'restart',
  RUNTIME_SPAWN_FAILED: 'restart',
  RUNTIME_START_FAILED: 'restart',
  RUNTIME_STOPPED: 'restart',
  RUNTIME_TERMINATION_FAILED: 'offline',
} as const satisfies Record<BuddyServiceSupervisorFailureCode, 'offline' | 'restart'>

export class BuddyServiceSupervisor {
  readonly #bindPeer?: BuddyServiceSupervisorOptions['bindPeer']
  readonly #diagnosticOutput: Writable
  readonly #onDiagnostic: BuddyServiceSupervisorOptions['onDiagnostic']
  #generationStartedAt = 0
  #sourceId = 'runtime'
  readonly #forceKillTimeoutMs: number
  readonly #notificationListeners = new Set<(notification: BuddyServiceNotification) => void>()
  readonly #readinessTimeoutMs: number
  readonly #restartDelaysMs: number[]
  readonly #shutdownTimeoutMs: number
  readonly #spawnService: BuddyServiceSupervisorOptions['spawnService']
  readonly #stableResetMs: number
  readonly #stateListeners = new Set<(state: BuddyServiceSupervisorState) => void>()
  readonly #exitedProcesses = new WeakSet<BuddyServiceProcessInstance>()
  readonly #exitCodes = new WeakMap<BuddyServiceProcessInstance, number>()
  #lastShutdownClean = true
  #desiredRunning = false
  #generation: ServiceGeneration | null = null
  #generationId = 0
  #intent = 0
  #lifecycleTail: Promise<void> = Promise.resolve()
  #readinessTimer: ReturnType<typeof setTimeout> | null = null
  #restartTimer: ReturnType<typeof setTimeout> | null = null
  #stableTimer: ReturnType<typeof setTimeout> | null = null
  #state: BuddyServiceSupervisorState = {
    lastError: null,
    pid: null,
    restartAttempt: 0,
    status: 'stopped',
  }

  constructor(options: BuddyServiceSupervisorOptions) {
    this.#bindPeer = options.bindPeer
    this.#diagnosticOutput = options.diagnosticOutput ?? process.stderr
    this.#onDiagnostic = options.onDiagnostic
    this.#forceKillTimeoutMs = options.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
    this.#restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    this.#spawnService = options.spawnService
    this.#stableResetMs = options.stableResetMs ?? DEFAULT_STABLE_RESET_MS
  }

  get state(): BuddyServiceSupervisorState {
    return this.#state
  }

  start(): void {
    if (this.#isReplacementBlocked())
      return
    if (this.#desiredRunning && this.#state.status !== 'offline')
      return
    this.#intent += 1
    this.#desiredRunning = true
    this.#clearTimers()
    this.#setState({ lastError: null, pid: null, restartAttempt: 0, status: 'starting' })
    if (!this.#generation) {
      this.#spawnGeneration()
      return
    }
    void this.restart()
  }

  async request(
    method: string,
    params: unknown,
    options: BuddyServiceRequestOptions = {},
  ): Promise<unknown> {
    const peer = await this.#waitForReadyPeer()
    return peer.request(method, params, options.timeoutMs, options.signal, options.requestId)
  }

  onStateChange(listener: (state: BuddyServiceSupervisorState) => void): () => void {
    this.#stateListeners.add(listener)
    return () => this.#stateListeners.delete(listener)
  }

  onNotification(listener: (notification: BuddyServiceNotification) => void): () => void {
    this.#notificationListeners.add(listener)
    return () => this.#notificationListeners.delete(listener)
  }

  notify(method: string, params: unknown): boolean {
    const generation = this.#generation
    if (!generation?.ready)
      return false
    generation.peer.notify(method, params)
    return true
  }

  async restart(): Promise<void> {
    if (this.#isReplacementBlocked())
      throw new BuddyServiceUnavailableError()
    const intent = ++this.#intent
    this.#desiredRunning = true
    this.#clearTimers()
    this.#setState({ ...this.#state, lastError: null, status: 'restarting' })
    return this.#enqueueLifecycle(async () => {
      const stopped = await this.#stopCurrentGeneration()
      if (intent !== this.#intent || !this.#desiredRunning)
        return
      if (!stopped) {
        this.#setTerminationFailure()
        return
      }
      this.#setState({ lastError: null, pid: null, restartAttempt: 0, status: 'starting' })
      this.#spawnGeneration()
    })
  }

  async stop(): Promise<void> {
    if (!this.#desiredRunning && this.#state.status === 'stopped')
      return
    const intent = ++this.#intent
    this.#desiredRunning = false
    this.#clearTimers()
    this.#setState({ ...this.#state, status: 'stopping' })
    return this.#enqueueLifecycle(async () => {
      const stopped = await this.#stopCurrentGeneration()
      if (intent !== this.#intent || this.#desiredRunning)
        return
      if (stopped)
        this.#setStopped()
      else
        this.#setTerminationFailure()
      if (!stopped || !this.#lastShutdownClean)
        throw new Error('Runtime shutdown did not complete cleanly')
    })
  }

  async #stopCurrentGeneration(): Promise<boolean> {
    const generation = this.#generation
    this.#lastShutdownClean = true
    if (!generation)
      return true
    this.#record({ event: 'runtime.shutdown.started', level: 'info' }, generation)
    generation.terminationRequested = true
    this.#generation = null
    this.#generationId += 1
    this.#clearReadinessTimer()
    this.#clearStableTimer()
    const exited = waitForProcessExit(
      generation.process,
      this.#exitedProcesses.has(generation.process),
    )
    void generation.peer.request('runtime.shutdown', {}, this.#shutdownTimeoutMs).catch(() => {})
    let stopped = await settleWithin(exited, this.#shutdownTimeoutMs)
    const forced = !stopped
    if (!stopped) {
      this.#record({ event: 'runtime.shutdown.forced', level: 'warn' }, generation)
      generation.process.kill()
      stopped = await settleWithin(exited, this.#forceKillTimeoutMs)
    }
    generation.disposeBinding()
    generation.peer.close(new BuddyServiceUnavailableError())
    this.#lastShutdownClean = stopped && !forced && this.#exitCodes.get(generation.process) === 0
    this.#record({ event: this.#lastShutdownClean ? 'runtime.shutdown.completed' : 'runtime.shutdown.failed', level: this.#lastShutdownClean ? 'info' : 'error' }, generation)
    return stopped
  }

  #spawnGeneration(): void {
    if (!this.#desiredRunning)
      return
    const id = ++this.#generationId
    this.#sourceId = `runtime-${id}`
    this.#generationStartedAt = performance.now()
    this.#record({ event: 'component.starting', level: 'info', component: 'runtime.connection', operationId: this.#sourceId })
    let handle: BuddyServiceProcessHandle | null = null
    const pendingFatalError: { value: Error | null } = { value: null }
    const onFatalError = (error: Error) => {
      if (!handle) {
        pendingFatalError.value = error
        return
      }
      const failure = toBuddyServiceFatalFailure(error)
      this.#failGeneration(id, failure, `Buddy Local Service failure: ${failure}`)
    }
    try {
      handle = this.#spawnService(onFatalError, this.#sourceId)
    }
    catch (error) {
      this.#handleSpawnFailure(id, error)
      return
    }
    const generation: ServiceGeneration = {
      ...handle,
      disposeBinding: this.#bindPeer?.(handle.peer) ?? (() => {}),
      id,
      ready: false,
      terminationRequested: false,
    }
    this.#generation = generation
    this.#record({ event: 'runtime.spawned', level: 'info', attempt: this.#state.restartAttempt }, generation)
    this.#setState({
      ...this.#state,
      lastError: null,
      pid: generation.process.pid ?? null,
      status: 'starting',
    })
    this.#scheduleReadinessTimeout(id)
    generation.peer.onNotification((method, params) => {
      if (method === APPLICATION_DIAGNOSTIC_METHOD && !this.#exitedProcesses.has(generation.process)) {
        const event = applicationDiagnosticSchema.safeParse(params)
        this.#record(event.success ? event.data : { event: 'runtime.diagnostic_invalid', level: 'warn' }, generation)
        return
      }
      if (this.#generation?.id !== id)
        return
      if (method === 'runtime.failed') {
        const failure = buddyServiceFailureNotificationSchema.safeParse(params)
        if (!failure.success) {
          this.#failGeneration(
            id,
            'RUNTIME_PROTOCOL_FAILED',
            'Buddy Local Service emitted an invalid failure notification',
          )
          return
        }
        this.#failGeneration(
          id,
          failure.data.code,
          `Buddy Local Service reported failure: ${failure.data.code}`,
        )
        return
      }
      if (method === 'runtime.ready') {
        const protocolVersion = readProtocolVersion(params)
        if (protocolVersion !== BUDDY_SERVICE_PROTOCOL_VERSION) {
          this.#failGeneration(
            id,
            'RUNTIME_PROTOCOL_INCOMPATIBLE',
            `Unsupported Buddy Local Service protocol version: ${protocolVersion ?? 'unknown'}`,
          )
          return
        }
        generation.ready = true
        this.#connectionSettled('completed')
        this.#clearReadinessTimer()
        this.#setState({
          ...this.#state,
          lastError: null,
          pid: generation.process.pid ?? null,
          status: 'ready',
        })
        this.#scheduleStableReset(id)
        return
      }
      if (!generation.ready)
        return
      for (const listener of this.#notificationListeners)
        listener({ method, params })
    })
    generation.process.once('exit', (code) => {
      this.#record({
        event: code === 0 ? 'runtime.exited' : 'runtime.exited_abnormally',
        level: code === 0 ? 'info' : 'error',
        processExit: { type: 'utility', reason: code === 0 ? 'clean-exit' : 'abnormal-exit', code, expected: generation.terminationRequested },
      }, generation)
      this.#exitCodes.set(generation.process, code)
      this.#exitedProcesses.add(generation.process)
      this.#handleExit(id, code)
    })
    if (pendingFatalError.value) {
      const failure = toBuddyServiceFatalFailure(pendingFatalError.value)
      this.#failGeneration(id, failure, `Buddy Local Service failure: ${failure}`)
    }
  }

  #handleSpawnFailure(id: number, error: unknown): void {
    if (id !== this.#generationId || !this.#desiredRunning)
      return
    const diagnostic = error instanceof Error ? error.name : 'unknown error'
    this.#connectionSettled('failed', 'RUNTIME_SPAWN_FAILED')
    this.#writeDiagnostic(`Buddy Local Service failed to spawn: ${diagnostic}`)
    this.#scheduleRestart('RUNTIME_SPAWN_FAILED')
  }

  #handleExit(id: number, code: number): void {
    if (this.#generation?.id !== id)
      return
    const generation = this.#generation
    if (!generation.ready)
      this.#connectionSettled('failed', 'RUNTIME_STOPPED')
    this.#generation = null
    this.#generationId += 1
    this.#clearReadinessTimer()
    this.#clearStableTimer()
    generation.disposeBinding()
    generation.peer.close(new BuddyServiceUnavailableError())
    if (!this.#desiredRunning) {
      this.#setStopped()
      return
    }
    this.#writeDiagnostic(`Buddy Local Service exited with code ${code}`)
    this.#scheduleRestart('RUNTIME_STOPPED')
  }

  #failGeneration(
    id: number,
    failure: BuddyServiceSupervisorFailureCode,
    diagnostic: string,
  ): void {
    const generation = this.#generation
    if (!generation || generation.id !== id || !this.#desiredRunning)
      return
    this.#connectionSettled('failed', failure)
    this.#generation = null
    this.#generationId += 1
    this.#clearReadinessTimer()
    this.#clearStableTimer()
    generation.disposeBinding()
    generation.peer.close(new BuddyServiceUnavailableError())
    this.#writeDiagnostic(diagnostic)
    this.#setState({
      lastError: failure,
      pid: generation.process.pid ?? null,
      restartAttempt: this.#state.restartAttempt,
      status: RUNTIME_FAILURE_DISPOSITIONS[failure] === 'offline'
        ? 'stopping'
        : 'restarting',
    })
    const intent = this.#intent
    void this.#enqueueLifecycle(async () => {
      const exited = waitForProcessExit(
        generation.process,
        this.#exitedProcesses.has(generation.process),
      )
      generation.terminationRequested = true
      generation.process.kill()
      const terminated = await settleWithin(exited, this.#forceKillTimeoutMs)
      if (intent !== this.#intent || !this.#desiredRunning)
        return
      if (!terminated) {
        this.#setTerminationFailure(generation.process.pid)
        return
      }
      this.#scheduleRestart(failure)
    })
  }

  #scheduleRestart(failure: BuddyServiceSupervisorFailureCode): void {
    if (!this.#desiredRunning)
      return
    const attempt = this.#state.restartAttempt
    if (RUNTIME_FAILURE_DISPOSITIONS[failure] === 'offline') {
      this.#setState({ lastError: failure, pid: null, restartAttempt: attempt, status: 'offline' })
      return
    }
    const delay = this.#restartDelaysMs[attempt]
    if (delay === undefined) {
      this.#setState({ lastError: failure, pid: null, restartAttempt: attempt, status: 'offline' })
      return
    }
    this.#setState({
      lastError: failure,
      pid: null,
      restartAttempt: attempt + 1,
      status: 'restarting',
    })
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null
      this.#spawnGeneration()
    }, delay)
  }

  #scheduleStableReset(id: number): void {
    this.#clearStableTimer()
    this.#stableTimer = setTimeout(() => {
      this.#stableTimer = null
      if (this.#generation?.id !== id || this.#state.status !== 'ready')
        return
      this.#setState({ ...this.#state, restartAttempt: 0 })
    }, this.#stableResetMs)
  }

  #scheduleReadinessTimeout(id: number): void {
    this.#clearReadinessTimer()
    this.#readinessTimer = setTimeout(() => {
      this.#readinessTimer = null
      this.#failGeneration(
        id,
        'RUNTIME_READINESS_TIMEOUT',
        'Buddy Local Service did not become ready in time',
      )
    }, this.#readinessTimeoutMs)
  }

  #waitForReadyPeer(): Promise<BuddyServicePeer> {
    if (this.#state.status === 'ready' && this.#generation?.ready)
      return Promise.resolve(this.#generation.peer)
    if (!this.#desiredRunning || ['offline', 'stopped', 'stopping'].includes(this.#state.status))
      return Promise.reject(new BuddyServiceUnavailableError())
    return new Promise((resolve, reject) => {
      let stopListening = () => {}
      const timeout = setTimeout(() => {
        stopListening()
        reject(new BuddyServiceUnavailableError('Buddy Local Service did not become ready in time'))
      }, this.#readinessTimeoutMs)
      stopListening = this.onStateChange((state) => {
        if (state.status === 'ready' && this.#generation?.ready) {
          clearTimeout(timeout)
          stopListening()
          resolve(this.#generation.peer)
          return
        }
        if (['offline', 'stopped', 'stopping'].includes(state.status)) {
          clearTimeout(timeout)
          stopListening()
          reject(new BuddyServiceUnavailableError())
        }
      })
    })
  }

  #writeDiagnostic(message: string): void {
    this.#diagnosticOutput.write(`[Buddy Local Service] ${message}\n`)
  }

  #setStopped(): void {
    this.#setState({ lastError: null, pid: null, restartAttempt: 0, status: 'stopped' })
  }

  #setTerminationFailure(pid = this.#generation?.process.pid): void {
    this.#setState({
      lastError: 'RUNTIME_TERMINATION_FAILED',
      pid: pid ?? null,
      restartAttempt: this.#state.restartAttempt,
      status: 'offline',
    })
  }

  #setState(state: BuddyServiceSupervisorState): void {
    if (state.status !== this.#state.status || state.lastError !== this.#state.lastError) {
      this.#record({
        event: `runtime.${state.status}`,
        level: state.lastError ? 'warn' : 'info',
        attempt: state.restartAttempt,
        ...(state.lastError ? { errorCode: state.lastError } : {}),
      })
    }
    this.#state = Object.freeze({ ...state })
    for (const listener of this.#stateListeners)
      listener(this.#state)
  }

  #record(event: ApplicationDiagnostic, generation = this.#generation): void {
    try {
      this.#onDiagnostic?.({ ...event, sourceId: generation ? `runtime-${generation.id}` : this.#sourceId, sourcePid: generation?.process.pid })
    }
    catch {}
  }

  #connectionSettled(status: 'completed' | 'failed', errorCode?: string): void {
    this.#record({ event: status === 'completed' ? 'component.ready' : 'component.start_failed', level: status === 'failed' ? 'error' : 'info', component: 'runtime.connection', operationId: this.#sourceId, durationMs: Math.round(performance.now() - this.#generationStartedAt), ...(errorCode ? { errorCode } : {}) })
  }

  #isReplacementBlocked(): boolean {
    return this.#state.status === 'offline' && this.#state.pid !== null
  }

  #clearTimers(): void {
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = null
    }
    this.#clearReadinessTimer()
    this.#clearStableTimer()
  }

  #clearReadinessTimer(): void {
    if (this.#readinessTimer) {
      clearTimeout(this.#readinessTimer)
      this.#readinessTimer = null
    }
  }

  #clearStableTimer(): void {
    if (this.#stableTimer) {
      clearTimeout(this.#stableTimer)
      this.#stableTimer = null
    }
  }

  #enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const next = this.#lifecycleTail.then(operation, operation)
    this.#lifecycleTail = next.catch(() => {})
    return next
  }
}

export class BuddyServiceUnavailableError extends Error {
  readonly code = 'RUNTIME_UNAVAILABLE'

  constructor(message = 'Buddy Local Service is unavailable') {
    super(message)
    this.name = 'BuddyServiceUnavailableError'
  }
}

function waitForProcessExit(
  serviceProcess: BuddyServiceProcessInstance,
  alreadyExited = false,
): Promise<void> {
  if (alreadyExited)
    return Promise.resolve()
  return new Promise(resolve => serviceProcess.once('exit', () => resolve()))
}

function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs, false)
    promise.then(
      () => {
        clearTimeout(timeout)
        resolve(true)
      },
      () => {
        clearTimeout(timeout)
        resolve(false)
      },
    )
  })
}

function readProtocolVersion(params: unknown): number | null {
  if (typeof params !== 'object' || params === null || Array.isArray(params))
    return null
  const version = Reflect.get(params, 'protocolVersion')
  return typeof version === 'number' && Number.isInteger(version) ? version : null
}

function toBuddyServiceFatalFailure(error: Error): BuddyServiceSupervisorFailureCode {
  if ('code' in error && error.code === 'RUNTIME_PROTOCOL_ERROR')
    return 'RUNTIME_PROTOCOL_FAILED'
  return 'RUNTIME_START_FAILED'
}
