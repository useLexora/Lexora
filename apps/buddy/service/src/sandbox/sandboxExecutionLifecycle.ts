import type { Buffer } from 'node:buffer'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { SandboxLifecycleEvent, SandboxLifecycleSnapshot, SandboxProcessState } from '../../../shared/permissions/sandboxLifecycle'
import type { SandboxNetworkTarget, SandboxResult } from '../../../shared/permissions/shellSandbox'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

export interface SandboxExecutionOptions {
  signal: AbortSignal
  approveNetwork: (target: SandboxNetworkTarget) => Promise<boolean>
  onData: (data: Buffer) => void
  onStarted: () => void
  onProcess?: (process: SandboxProcessState) => void
}

export class SandboxExecutionLifecycle {
  readonly #controller = new AbortController()
  readonly #changes = new Emitter<EventSnapshot<SandboxLifecycleEvent>>(() => console.error('SANDBOX_LIFECYCLE_OBSERVER_FAILED'))
  readonly #externalSignal: AbortSignal
  readonly #cancel = () => {
    if (this.#phase === 'finished' || this.#cancellation !== 'none')
      return
    this.#cancellation = 'requested'
    this.#clear()
    this.#publish('cancel-requested')
  }

  readonly onDidChange = this.#changes.event
  readonly signal: AbortSignal
  #timer: ReturnType<typeof setTimeout> | undefined
  #startedAt = 0
  #remaining: number
  #waiting = 0
  #revision = 0
  #begun = false
  #started = false
  #phase: SandboxLifecycleSnapshot['phase'] = 'preparing'
  #cancellation: SandboxLifecycleSnapshot['cancellation'] = 'none'
  #result: SandboxResult | undefined
  #process: SandboxProcessState | undefined

  constructor(signal: AbortSignal, timeoutSeconds = 30 * 60, preparationTimeoutMs = 60_000) {
    this.#externalSignal = signal
    this.signal = AbortSignal.any([signal, this.#controller.signal])
    this.#remaining = timeoutSeconds * 1_000
    if (signal.aborted) {
      this.#cancellation = 'requested'
    }
    else {
      signal.addEventListener('abort', this.#cancel, { once: true })
      this.#arm(preparationTimeoutMs)
    }
  }

  get started(): boolean { return this.#started }
  get timedOut(): boolean { return this.#cancellation === 'timed-out' }
  get snapshot(): EventSnapshot<SandboxLifecycleSnapshot> {
    return copyEventSnapshot({ phase: this.#phase, started: this.#started, waiting: this.#waiting, cancellation: this.#cancellation, process: this.#process, ...this.#result ? { result: this.#result } : {} })
  }

  processChanged(process: SandboxProcessState): void {
    if (this.#phase === 'finished')
      return
    this.#process = { ...process }
    this.#publish('process')
  }

  begin(): void {
    if (this.#begun || this.#phase === 'finished')
      return
    this.#begun = true
    this.#publish('preparing')
  }

  start(): void {
    this.signal.throwIfAborted()
    if (this.#phase !== 'preparing')
      return
    this.#clear()
    this.#started = true
    this.#phase = 'running'
    this.#resume()
    this.#publish('started')
  }

  async approve(request: () => Promise<boolean>): Promise<boolean> {
    if (this.#phase === 'finished')
      return false
    if (this.#waiting++ === 0 && this.#phase === 'running' && this.#timer) {
      this.#remaining -= performance.now() - this.#startedAt
      this.#clear()
    }
    this.#publish('approval-wait')
    try {
      this.signal.throwIfAborted()
      const allowed = await request()
      return !this.signal.aborted && allowed
    }
    finally {
      this.#waiting = Math.max(0, this.#waiting - 1)
      const resumed = this.#resume()
      if (this.snapshot.phase !== 'finished')
        this.#publish(resumed ? 'approval-resumed' : 'approval-settled')
    }
  }

  finish(result?: SandboxResult): void {
    if (this.#phase === 'finished')
      return
    this.#phase = 'finished'
    this.#result = result ? copyEventSnapshot(result) : undefined
    this.#waiting = 0
    this.#clear()
    this.#externalSignal.removeEventListener('abort', this.#cancel)
    this.#controller.abort()
    this.#publish(result ? 'settled' : 'released')
    this.#changes.dispose()
  }

  #publish(kind: SandboxLifecycleEvent['kind']): void {
    this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, kind, snapshot: this.snapshot }))
  }

  #resume(): boolean {
    if (this.#phase !== 'running' || this.#waiting || this.signal.aborted)
      return false
    this.#startedAt = performance.now()
    this.#arm(this.#remaining)
    return true
  }

  #arm(milliseconds: number): void {
    this.#timer = setTimeout(() => {
      this.#cancellation = 'timed-out'
      this.#controller.abort()
      this.#publish('timed-out')
    }, Math.max(1, milliseconds))
    this.#timer.unref()
  }

  #clear(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
  }
}
