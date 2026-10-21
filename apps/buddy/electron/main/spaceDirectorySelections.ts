import { resolve } from 'node:path'

const DEFAULT_SELECTION_TTL_MS = 30 * 60 * 1_000

export interface SpaceDirectorySelectionLedgerOptions {
  now?: () => number
  ttlMs?: number
}

export class SpaceDirectorySelectionLedger {
  readonly #expiresAt = new Map<string, number>()
  readonly #now: () => number
  readonly #ttlMs: number

  constructor(options: SpaceDirectorySelectionLedgerOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.ttlMs ?? DEFAULT_SELECTION_TTL_MS
  }

  issue(root: string): void {
    const now = this.#now()
    this.#prune(now)
    this.#expiresAt.set(resolve(root), now + this.#ttlMs)
  }

  consume(root: string): boolean {
    const now = this.#now()
    this.#prune(now)
    const key = resolve(root)
    if (!this.#expiresAt.delete(key))
      return false
    return true
  }

  consumeAll(roots: readonly string[]): boolean {
    this.#prune(this.#now())
    const keys = roots.map(root => resolve(root))
    if (new Set(keys).size !== keys.length || keys.some(key => !this.#expiresAt.has(key)))
      return false
    for (const key of keys)
      this.#expiresAt.delete(key)
    return true
  }

  #prune(now: number): void {
    for (const [root, expiresAt] of this.#expiresAt) {
      if (expiresAt <= now)
        this.#expiresAt.delete(root)
    }
  }
}
