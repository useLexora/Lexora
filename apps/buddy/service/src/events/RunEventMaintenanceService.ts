import { performance } from 'node:perf_hooks'
import { setImmediate as yieldTurn } from 'node:timers/promises'

export interface RunEventMaintenanceSummary {
  durationMs: number
  checked: number
  removed: number
  failed: number
}

export interface RunEventMaintenanceOptions {
  isBusy?: () => boolean
}

export class RunEventMaintenanceService {
  readonly #list: (after: string, limit: number) => string[]
  readonly #compact: (runId: string) => Promise<number>
  readonly #onFailure: (error: unknown) => boolean
  readonly #onSummary?: (summary: Readonly<RunEventMaintenanceSummary>) => void
  #isBusy: () => boolean = () => false
  #timer: ReturnType<typeof setTimeout> | undefined
  #current: Promise<void> | undefined
  #stopped = true
  #busySince = 0
  #cursor = ''

  constructor(options: {
    list: (after: string, limit: number) => string[]
    compact: (runId: string) => Promise<number>
    onFailure: (error: unknown) => boolean
    onSummary?: (summary: Readonly<RunEventMaintenanceSummary>) => void
  }) {
    this.#list = options.list
    this.#compact = options.compact
    this.#onFailure = options.onFailure
    this.#onSummary = options.onSummary
  }

  start(options: RunEventMaintenanceOptions = {}): void {
    if (!this.#stopped)
      return
    this.#stopped = false
    this.#cursor = ''
    this.#isBusy = options.isBusy ?? (() => false)
    this.wake()
  }

  wake(): void {
    this.#schedule(1_000)
  }

  async stop(): Promise<void> {
    this.#stopped = true
    clearTimeout(this.#timer)
    this.#timer = undefined
    await this.#current
  }

  #schedule(delay: number): void {
    if (this.#stopped || this.#timer || this.#current)
      return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#current = this.#tick().finally(() => {
        this.#current = undefined
      })
    }, delay)
    this.#timer.unref()
  }

  async #tick(): Promise<void> {
    const started = performance.now()
    const summary: RunEventMaintenanceSummary = { durationMs: 0, checked: 0, removed: 0, failed: 0 }
    let delay = 30_000
    try {
      const busy = this.#isBusy()
      if (busy && this.#busySince === 0)
        this.#busySince = started
      if (busy && started - this.#busySince < 30_000) {
        delay = 1_000
        return
      }
      this.#busySince = 0
      const candidates = this.#list(this.#cursor, busy ? 1 : 16)
      for (const runId of candidates) {
        if (this.#stopped)
          break
        this.#cursor = runId
        summary.checked++
        try {
          summary.removed += await this.#compact(runId)
        }
        catch (error) {
          summary.failed++
          if (!this.#onFailure(error)) {
            this.#stopped = true
            break
          }
        }
        await yieldTurn()
      }
      if (candidates.length > 0)
        delay = busy ? 1_000 : 0
      else
        this.#cursor = ''
    }
    catch (error) {
      summary.failed++
      if (!this.#onFailure(error))
        this.#stopped = true
    }
    finally {
      if (summary.checked || summary.failed) {
        summary.durationMs = performance.now() - started
        try {
          this.#onSummary?.(Object.freeze(summary))
        }
        catch {}
      }
      if (!this.#stopped) {
        this.#timer = setTimeout(() => {
          this.#timer = undefined
          this.#current = this.#tick().finally(() => {
            this.#current = undefined
          })
        }, delay)
        this.#timer.unref()
      }
    }
  }
}
