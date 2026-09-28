import type { Readable, Writable } from 'node:stream'
import type {
  PetExecuteSequenceParams,
  PetExecuteSequenceResult,
  PetPrimitiveStep,
} from '../../../shared/runtime/petProtocol'
import type { NativePetChange, NativePetFact } from './NativePetEvents'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { petExecuteSequenceParamsSchema } from '../../../shared/runtime/petProtocol'
import {
  NativePetProtocolError,
  NativePetRpcClient,
  NativePetUnavailableError,
} from './NativePetRpcClient'

const DEFAULT_RESTART_DELAYS_MS = [250, 1000, 3000, 5000]
const DEFAULT_STABLE_RESET_MS = 60_000
const NATIVE_PET_ENVIRONMENT_KEYS = new Set([
  'DBUS_SESSION_BUS_ADDRESS',
  'DESKTOP_SESSION',
  'DISPLAY',
  'GDK_BACKEND',
  'GTK_THEME',
  'HOME',
  'LANG',
  'LANGUAGE',
  'NO_AT_BRIDGE',
  'PATH',
  'QT_QPA_PLATFORM',
  'QT_SCALE_FACTOR',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'TMPDIR',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_CONFIG_HOME',
  'XDG_CURRENT_DESKTOP',
  'XDG_DATA_DIRS',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_DESKTOP',
  'XDG_SESSION_TYPE',
  'XDG_STATE_HOME',
])

export interface NativePetChildProcess {
  pid?: number
  stderr: Readable
  stdin: Writable
  stdout: Readable
  kill: (signal?: NodeJS.Signals | number) => boolean
  once: (
    ((event: 'error', listener: (error: Error) => void) => unknown)
    & ((event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown)
  )
}

export type NativePetSupervisorState
  = { status: 'stopped' }
    | { status: 'stopping' | 'stop-unknown' }
    | { status: 'starting' | 'ready' | 'restarting', pid?: number, restartAttempt: number }
    | { status: 'offline', restartAttempt: number }

export interface NativePetSupervisorOptions {
  captureStderr?: (output: NodeJS.ReadableStream) => void
  diagnosticOutput?: Writable
  onOpenDesktop?: () => void
  readinessTimeoutMs?: number
  restartDelaysMs?: readonly number[]
  spawnPet: () => NativePetChildProcess
  stableResetMs?: number
  stopTimeoutMs?: number
}

interface ActiveSequence {
  operationId: string
  currentStepId: string | null
  priority: number
  promise: Promise<PetExecuteSequenceResult>
}

interface NativePetGeneration {
  identity: string
  exited: Promise<void>
  resolveExit: () => void
  client: NativePetRpcClient
  id: number
  process: NativePetChildProcess
}

export class NativePetSupervisor {
  readonly #changes = new Emitter<NativePetChange>(() => console.error('PET_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  readonly #retiring = new Set<NativePetGeneration>()
  readonly #stopTimeoutMs: number
  #stopPromise: Promise<void> | undefined
  #disposing: Promise<void> | undefined
  readonly #captureStderr?: (output: NodeJS.ReadableStream) => void
  readonly #diagnosticOutput: Writable
  readonly #onOpenDesktop?: () => void
  readonly #readinessTimeoutMs: number
  readonly #restartDelaysMs: readonly number[]
  readonly #spawnPet: () => NativePetChildProcess
  readonly #stableResetMs: number
  #activeSequence: ActiveSequence | null = null
  #admissionTail: Promise<void> = Promise.resolve()
  #generation: NativePetGeneration | null = null
  #generationId = 0
  #restartAttempt = 0
  #restartTimer: ReturnType<typeof setTimeout> | null = null
  #stableTimer: ReturnType<typeof setTimeout> | null = null
  #stopping = false
  #state: NativePetSupervisorState = { status: 'stopped' }

  constructor(options: NativePetSupervisorOptions) {
    this.#captureStderr = options.captureStderr
    this.#diagnosticOutput = options.diagnosticOutput ?? process.stderr
    this.#onOpenDesktop = options.onOpenDesktop
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 8000
    this.#restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS
    this.#spawnPet = options.spawnPet
    this.#stableResetMs = options.stableResetMs ?? DEFAULT_STABLE_RESET_MS
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 2000
  }

  get state(): NativePetSupervisorState {
    return copyEventSnapshot(this.#state)
  }

  get snapshot() { return copyEventSnapshot({ revision: this.#revision, state: this.#state, generation: this.#generation?.identity ?? null, retiring: [...this.#retiring].map(generation => generation.identity) }) }

  reloadConfig(): boolean {
    const generation = this.#generation
    if (this.#stopping || this.#disposing || !generation?.client.ready || this.#state.status !== 'ready')
      return false
    generation.client.reloadConfig()
    this.#publish({ kind: 'configuration', status: 'reload-requested' }, generation.identity)
    return true
  }

  start(): void {
    if (this.#disposing)
      throw new NativePetUnavailableError('PET_STOPPED')
    if (this.#stopPromise)
      throw new NativePetUnavailableError('PET_STOPPING')
    if (this.#retiring.size)
      throw new NativePetUnavailableError('PET_STOP_UNCONFIRMED')
    if (this.#generation || this.#restartTimer || this.#state.status === 'ready')
      return
    this.#stopping = false
    this.#restartAttempt = 0
    this.#startGeneration()
  }

  stop(): Promise<void> {
    if (this.#stopPromise)
      return this.#stopPromise
    this.#stopping = true
    const stop = Promise.resolve().then(() => this.#stop()).finally(() => {
      if (this.#stopPromise === stop)
        this.#stopPromise = undefined
    })
    this.#stopPromise = stop
    return stop
  }

  async #stop(): Promise<void> {
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = null
    }
    this.#clearStableTimer()
    const generation = this.#generation
    this.#generation = null
    if (generation) {
      this.#retiring.add(generation)
      this.#setState({ status: 'stopping' }, generation.identity)
      this.#publish({ kind: 'process', status: 'stop-requested' }, generation.identity)
    }
    generation?.client.close(new NativePetUnavailableError())
    generation?.process.stdin.end()
    generation?.process.kill('SIGTERM')
    await this.#admissionTail
    await this.#activeSequence?.promise.catch(() => {})
    this.#activeSequence = null
    const retiring = [...this.#retiring]
    if (retiring.length) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const exited = await Promise.race([
          Promise.all(retiring.map(current => current.exited)).then(() => true),
          new Promise<false>(resolve => timer = setTimeout(resolve, this.#stopTimeoutMs, false)),
        ])
        if (!exited) {
          this.#setState({ status: 'stop-unknown' }, generation?.identity)
          this.#publish({ kind: 'process', status: 'stop-unknown' }, generation?.identity)
          throw new NativePetUnavailableError('PET_STOP_UNCONFIRMED')
        }
      }
      finally { clearTimeout(timer) }
    }
    this.#setState({ status: 'stopped' }, generation?.identity)
  }

  async executeSequence(input: PetExecuteSequenceParams): Promise<PetExecuteSequenceResult> {
    const request = petExecuteSequenceParamsSchema.parse(input)
    const admitted = await this.#withAdmission(async () => {
      const generation = this.#generation
      if (this.#stopping || !generation || !generation.client.ready || this.#state.status !== 'ready')
        return failedResult('PET_UNAVAILABLE', 0)

      const previous = this.#activeSequence
      if (previous) {
        if (request.priority <= previous.priority)
          return failedResult('PET_BUSY', 0)
        if (previous.currentStepId) {
          try {
            generation.client.interruptStep(previous.currentStepId)
          }
          catch {
            return failedResult('PET_UNAVAILABLE', 0)
          }
        }
        await previous.promise.catch(() => {})
      }
      if (
        this.#stopping
        || this.#generation?.id !== generation.id
        || !generation.client.ready
        || this.#state.status !== 'ready'
      ) {
        return failedResult('PET_UNAVAILABLE', 0)
      }
      const active: ActiveSequence = {
        operationId: randomUUID(),
        currentStepId: null,
        priority: request.priority,
        promise: Promise.resolve(failedResult('PET_UNAVAILABLE', 0)),
      }
      active.promise = Promise.resolve().then(() => this.#runSequence(generation, request.steps, active))
      this.#activeSequence = active
      return active
    })
    if (!('promise' in admitted))
      return admitted
    try {
      return await admitted.promise
    }
    finally {
      if (this.#activeSequence === admitted)
        this.#activeSequence = null
    }
  }

  #startGeneration(): void {
    if (this.#stopping)
      return

    let petProcess: NativePetChildProcess
    try {
      petProcess = this.#spawnPet()
    }
    catch (error) {
      const diagnostic = error instanceof Error
        ? `${error.name}: ${error.message}`
        : 'unknown error'
      try {
        this.#diagnosticOutput.write(`Native pet process failed to start: ${diagnostic}\n`)
      }
      catch {}
      this.#publish({ kind: 'process', status: 'spawn-failed' })
      this.#scheduleRestart()
      return
    }
    const id = ++this.#generationId
    const client = new NativePetRpcClient({
      readable: petProcess.stdout,
      writable: petProcess.stdin,
    })
    let resolveExit!: () => void
    const generation = { client, id, process: petProcess, identity: randomUUID(), exited: new Promise<void>(resolve => resolveExit = resolve), resolveExit: () => resolveExit() }
    this.#generation = generation
    this.#setState({
      pid: petProcess.pid,
      restartAttempt: this.#restartAttempt,
      status: 'starting',
    })
    if (this.#captureStderr)
      this.#captureStderr(petProcess.stderr)
    else
      petProcess.stderr.pipe(this.#diagnosticOutput, { end: false })
    client.onOpenDesktop(() => this.#onOpenDesktop?.())
    client.onFatalError(() => {
      if (this.#generation?.id === id)
        petProcess.kill('SIGTERM')
    })
    petProcess.once('error', () => {
      if (petProcess.pid === undefined)
        this.#finishGeneration(generation, 'spawn-failed')
      else if (this.#generation?.id === id)
        petProcess.kill('SIGTERM')
    })
    petProcess.once('exit', () => this.#finishGeneration(generation, 'exited'))
    void client.waitUntilReady(this.#readinessTimeoutMs).then(() => {
      if (this.#generation?.id !== id || this.#stopping)
        return
      this.#setState({
        pid: petProcess.pid,
        restartAttempt: this.#restartAttempt,
        status: 'ready',
      })
      this.#scheduleStableReset(id)
    }).catch(() => {
      if (this.#generation?.id === id)
        petProcess.kill('SIGTERM')
    })
  }

  #finishGeneration(generation: NativePetGeneration, status: 'exited' | 'spawn-failed'): void {
    generation.resolveExit()
    this.#retiring.delete(generation)
    this.#publish({ kind: 'process', status }, generation.identity)
    this.#handleExit(generation.id)
    if (this.#stopping && !this.#generation && !this.#retiring.size)
      this.#setState({ status: 'stopped' }, generation.identity)
  }

  #handleExit(id: number): void {
    if (this.#generation?.id !== id)
      return
    this.#generation.client.close(new NativePetUnavailableError())
    this.#generation = null
    this.#clearStableTimer()
    if (this.#stopping) {
      this.#setState({ status: 'stopped' })
      return
    }
    this.#scheduleRestart()
  }

  #scheduleRestart(): void {
    if (this.#stopping)
      return
    const delay = this.#restartDelaysMs[this.#restartAttempt]
    if (delay === undefined) {
      this.#setState({ restartAttempt: this.#restartAttempt, status: 'offline' })
      return
    }
    this.#setState({ restartAttempt: this.#restartAttempt, status: 'restarting' })
    this.#restartAttempt += 1
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null
      this.#startGeneration()
    }, delay)
  }

  #scheduleStableReset(id: number): void {
    this.#clearStableTimer()
    this.#stableTimer = setTimeout(() => {
      this.#stableTimer = null
      if (this.#generation?.id !== id || this.#state.status !== 'ready')
        return
      this.#restartAttempt = 0
      this.#setState({ ...this.#state, restartAttempt: 0 })
    }, this.#stableResetMs)
  }

  #clearStableTimer(): void {
    if (!this.#stableTimer)
      return
    clearTimeout(this.#stableTimer)
    this.#stableTimer = null
  }

  async #withAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#admissionTail
    let release!: () => void
    this.#admissionTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    }
    finally {
      release()
    }
  }

  async #runSequence(
    generation: NativePetGeneration,
    steps: readonly PetPrimitiveStep[],
    active: ActiveSequence,
  ): Promise<PetExecuteSequenceResult> {
    let completedSteps = 0
    for (const step of steps) {
      if (this.#generation?.id !== generation.id)
        return failedResult('PET_UNAVAILABLE', completedSteps)
      const stepId = `step_${randomUUID()}`
      active.currentStepId = stepId
      const identity = { operationId: active.operationId, stepId, index: completedSteps, action: step.kind }
      this.#publish({ kind: 'step', ...identity, status: 'dispatched', completedSteps }, generation.identity)
      try {
        const result = await generation.client.executeStep(step, stepId)
        this.#publish({ kind: 'step', ...identity, status: result.status, completedSteps: completedSteps + (result.status === 'completed' ? 1 : 0) }, generation.identity)
        if (result.status === 'interrupted') {
          return {
            completedSteps,
            reasonCode: result.reasonCode,
            status: 'interrupted',
          }
        }
        if (result.status === 'failed') {
          await this.#recoverAfterFailure(generation, active.operationId)
          return failedResult(result.code, completedSteps)
        }
        completedSteps += 1
      }
      catch (error) {
        const code = error instanceof NativePetProtocolError
          ? 'PET_PROTOCOL_ERROR'
          : 'PET_UNAVAILABLE'
        this.#publish({ kind: 'step', ...identity, status: 'unknown', completedSteps }, generation.identity)
        return failedResult(code, completedSteps)
      }
      finally {
        active.currentStepId = null
      }
    }
    return { completedSteps, status: 'completed' }
  }

  async #recoverAfterFailure(generation: NativePetGeneration, operationId: string): Promise<void> {
    if (this.#generation?.id !== generation.id || !generation.client.ready)
      return
    try {
      this.#publish({ kind: 'recovery', operationId, status: 'requested' }, generation.identity)
      const result = await generation.client.executeStep(safeHomeStep())
      this.#publish({ kind: 'recovery', operationId, status: result.status === 'completed' ? 'completed' : 'failed' }, generation.identity)
    }
    catch {
      this.#publish({ kind: 'recovery', operationId, status: 'unknown' }, generation.identity)
    }
  }

  #setState(state: NativePetSupervisorState, generation?: string): void {
    if (JSON.stringify(this.#state) === JSON.stringify(state))
      return
    this.#state = state
    this.#publish({ kind: 'state', state }, generation)
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.stop().finally(() => this.#changes.dispose())
    return this.#disposing
  }

  #publish(fact: NativePetFact, generation = this.#generation?.identity ?? null): void {
    this.#changes.fire(copyEventSnapshot({ ...fact, generation, revision: ++this.#revision }))
  }
}

export interface NativePetExecutableOptions {
  appPath: string
  isPackaged: boolean
  petPathOverride?: string
  resourcesPath: string
}

export interface NativePetProcessFactoryOptions extends NativePetExecutableOptions {
  env: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  spawnPet?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv, stdio: 'pipe', windowsHide: true },
  ) => NativePetChildProcess
}

export function resolveNativePetExecutable(options: NativePetExecutableOptions): string {
  if (options.petPathOverride) {
    if (!isAbsolute(options.petPathOverride))
      throw new Error('LEXORA_BUDDY_PET_PATH must be an absolute path')
    return options.petPathOverride
  }
  if (options.isPackaged)
    return join(options.resourcesPath, 'native-pet', 'lexora-buddy-pet')
  return join(
    options.appPath,
    '.output',
    'build',
    'native',
    'debug',
    'lexora-buddy-pet',
  )
}

export function createNativePetProcessFactory(
  options: NativePetProcessFactoryOptions,
): () => NativePetChildProcess {
  const executable = resolveNativePetExecutable(options)
  const exists = options.exists ?? existsSync
  const spawnPet = options.spawnPet ?? ((command, args, spawnOptions) => (
    spawn(command, args, spawnOptions)
  ))
  return () => {
    if (!exists(executable))
      throw new Error(`Lexora Buddy pet executable not found: ${executable}`)
    return spawnPet(executable, ['--native-pet'], {
      env: {
        ...createNativePetEnvironment(options.env),
        LEXORA_BUDDY_PET_EXIT_ON_STDIN_CLOSE: '1',
      },
      stdio: 'pipe',
      windowsHide: true,
    })
  }
}

export function createNativePetEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => (
    value !== undefined
    && (
      NATIVE_PET_ENVIRONMENT_KEYS.has(key)
      || key.startsWith('LC_')
      || key === 'LEXORA_HOME'
      || key.startsWith('LEXORA_BUDDY_PET_')
      || key.startsWith('LEXORA_BUDDY_NATIVE_PET_')
    )
  )))
}

function safeHomeStep(): PetPrimitiveStep {
  return {
    after: 'idle',
    interruptPolicy: 'interruptible',
    kind: 'moveByPath',
    path: [{ kind: 'home' }],
    timeoutMs: 15_000,
  }
}

function failedResult(
  code: 'PET_BUSY' | 'PET_PROTOCOL_ERROR' | 'PET_STEP_FAILED' | 'PET_UNAVAILABLE',
  completedSteps: number,
): PetExecuteSequenceResult {
  return { code, completedSteps, status: 'failed' }
}
