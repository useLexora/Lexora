export class ShellCommandDeadline {
  readonly #controller = new AbortController()
  readonly signal = this.#controller.signal
  readonly #seconds: unknown
  #timer: ReturnType<typeof setTimeout> | undefined
  #startedAt: number | undefined
  waiting = false
  errorCode: 'SHELL_RESOURCE_TIMEOUT' | 'SHELL_COMMAND_TIMEOUT' = 'SHELL_COMMAND_TIMEOUT'

  constructor(seconds: unknown) {
    this.#seconds = seconds
  }

  start(): void {
    if (this.#startedAt !== undefined || this.#seconds === undefined)
      return
    if (typeof this.#seconds !== 'number' || !Number.isFinite(this.#seconds) || this.#seconds <= 0 || this.#seconds * 1000 > 2_147_483_647)
      throw new Error('VALIDATION_FAILED')
    this.#startedAt = performance.now()
    this.#timer = setTimeout(() => {
      this.errorCode = this.waiting ? 'SHELL_RESOURCE_TIMEOUT' : 'SHELL_COMMAND_TIMEOUT'
      this.#controller.abort(new Error(`${this.errorCode}: Command timed out after ${this.#seconds} seconds, including resource waiting.${this.waiting ? ' The command did not start.' : ''}`))
    }, this.#seconds * 1000)
    this.#timer.unref()
  }

  startExecution(): number | undefined {
    if (this.#startedAt === undefined || typeof this.#seconds !== 'number')
      return undefined
    this.signal.throwIfAborted()
    this.dispose()
    const remaining = this.#seconds - (performance.now() - this.#startedAt) / 1000
    if (remaining <= 0) {
      this.#controller.abort(new Error('SHELL_COMMAND_TIMEOUT: Command budget expired before execution. The command did not start.'))
      this.signal.throwIfAborted()
    }
    return remaining
  }

  dispose(): void {
    clearTimeout(this.#timer)
  }
}
