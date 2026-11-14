import type { BrowserScreenshotRef } from '../../../shared/browser'
import type { SemanticBrowserTarget } from './browserObservationProjection'
import { BrowserHostError } from './BrowserHostError'

interface BrowserObservationEntry {
  documentRevision: number
  screenshot?: { bytes: Uint8Array, ref: BrowserScreenshotRef }
  targets: ReadonlyMap<string, SemanticBrowserTarget>
}

interface StoredObservation extends BrowserObservationEntry {
  expiresAt: number
  requiresHumanInput: boolean
}

interface Options {
  now: () => number
  ttlMs: number
  maxObservations?: number
}

const MAX_SCREENSHOT_CACHE_BYTES = 32 * 1_024 * 1_024

export class BrowserObservationStore {
  readonly #observations = new Map<string, StoredObservation>()
  readonly #options: Options
  #expiryTimer: ReturnType<typeof setTimeout> | null = null
  #disposed = false

  constructor(options: Options) {
    this.#options = options
  }

  get(id: string): StoredObservation | undefined {
    this.#prune()
    return this.#observations.get(id)
  }

  store(id: string, observation: BrowserObservationEntry): void {
    if (this.#disposed)
      throw new BrowserHostError('BROWSER_PAGE_FAILED', 'Browser observation store is disposed')
    this.#prune()
    this.#observations.delete(id)
    this.#observations.set(id, {
      ...observation,
      expiresAt: this.#options.now() + this.#options.ttlMs,
      requiresHumanInput: [...observation.targets.values()].some(target => target.inputMode === 'human'),
    })
    let bytes = [...this.#observations.values()].reduce((total, entry) => total + (entry.screenshot?.bytes.byteLength ?? 0), 0)
    while (this.#observations.size > (this.#options.maxObservations ?? 8) || bytes > MAX_SCREENSHOT_CACHE_BYTES) {
      const oldest = this.#observations.keys().next().value
      if (oldest === undefined)
        break
      bytes -= this.#observations.get(oldest)?.screenshot?.bytes.byteLength ?? 0
      this.#observations.delete(oldest)
    }
    this.#scheduleExpiry()
  }

  clear(): void {
    if (this.#expiryTimer)
      clearTimeout(this.#expiryTimer)
    this.#expiryTimer = null
    this.#observations.clear()
  }

  dispose(): void {
    this.#disposed = true
    this.clear()
  }

  #prune(): void {
    const now = this.#options.now()
    for (const [id, observation] of this.#observations) {
      if (observation.expiresAt <= now)
        this.#observations.delete(id)
    }
  }

  #scheduleExpiry(): void {
    if (this.#expiryTimer)
      clearTimeout(this.#expiryTimer)
    this.#expiryTimer = null
    if (!this.#observations.size)
      return
    const expiresAt = Math.min(...[...this.#observations.values()].map(observation => observation.expiresAt))
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = null
      this.#prune()
      this.#scheduleExpiry()
    }, Math.max(1, expiresAt - this.#options.now()))
    this.#expiryTimer.unref()
  }
}
