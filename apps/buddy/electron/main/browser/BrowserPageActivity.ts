import type { BrowserDebugger } from './BrowserDebugger'

export class BrowserPageActivity {
  readonly #connection: BrowserDebugger
  readonly #getFreezeDelay: () => number | null
  readonly #onError: () => void
  readonly #onResumed: () => void
  #timer: ReturnType<typeof setTimeout> | null = null
  #delay: number | null = null
  #idleSince = Date.now()
  #transition = Promise.resolve()
  #requestedFrozen: boolean | null = false
  #frozen = false
  #operations = 0
  #disposed = false

  constructor(options: { connection: BrowserDebugger, getFreezeDelay: () => number | null, onError: () => void, onResumed: () => void }) {
    this.#connection = options.connection
    this.#getFreezeDelay = options.getFreezeDelay
    this.#onError = options.onError
    this.#onResumed = options.onResumed
  }

  update(): Promise<void> {
    if (this.#disposed)
      return Promise.resolve()
    const delay = this.#operations > 0 ? null : this.#getFreezeDelay()
    if (delay !== this.#delay) {
      this.#delay = delay
      void this.resume().catch(this.#onError)
    }
    if (delay === null)
      return this.resume()
    if (!this.#timer && this.#requestedFrozen !== true) {
      this.#timer = setTimeout(() => {
        this.#timer = null
        if (this.#disposed)
          return
        const idle = Date.now() - this.#idleSince
        if (this.#operations === 0 && this.#getFreezeDelay() === delay && idle >= delay)
          void this.#request(true).catch(this.#onError)
        else
          void this.update().catch(this.#onError)
      }, Math.max(0, this.#idleSince + delay - Date.now()))
      this.#timer.unref()
    }
    return this.#transition
  }

  markActive(): Promise<void> {
    this.#idleSince = Date.now()
    void this.#request(false).catch(this.#onError)
    return this.update()
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.#operations += 1
    try {
      await this.resume()
      return await operation()
    }
    finally {
      this.#operations -= 1
      void this.markActive().catch(this.#onError)
    }
  }

  resume(): Promise<void> {
    this.#clearTimer()
    this.#idleSince = Date.now()
    return this.#request(false)
  }

  dispose(): void {
    this.#disposed = true
    this.#clearTimer()
  }

  #clearTimer(): void {
    if (this.#timer)
      clearTimeout(this.#timer)
    this.#timer = null
  }

  #request(frozen: boolean): Promise<void> {
    if (this.#disposed)
      return Promise.resolve()
    if (this.#requestedFrozen === frozen)
      return this.#transition
    this.#requestedFrozen = frozen
    this.#transition = this.#transition.catch(() => {}).then(async () => {
      if (this.#disposed || this.#frozen === frozen)
        return
      this.#connection.ensureAttached()
      await this.#connection.sendCommand('Page.setWebLifecycleState', { state: frozen ? 'frozen' : 'active' })
      if (!frozen && !this.#disposed)
        this.#onResumed()
      this.#frozen = frozen
    }).catch((error) => {
      if (this.#requestedFrozen === frozen)
        this.#requestedFrozen = null
      throw error
    })
    return this.#transition
  }
}
