import { CommandResultUnknownError } from '../commands/CommandAdmissionError'
import { StorageIsolatedError } from '../storage/StorageIsolation'
import { readTransactionFailure } from '../storage/transaction'

interface PreparedResources {
  commit: () => Promise<void>
  rollback: () => Promise<void>
  retain: () => Promise<void>
}

export function isPreparedResourceResultUnknown(error: unknown): boolean {
  return error instanceof CommandResultUnknownError || error instanceof StorageIsolatedError || readTransactionFailure(error)?.outcome === 'unknown'
}

export class PreparedResourceSettlement {
  readonly #resources: PreparedResources | null | undefined
  readonly #onError: (error: unknown) => void
  #settlement?: Promise<void>

  constructor(resources: PreparedResources | null | undefined, onError: (error: unknown) => void = () => {}) {
    this.#resources = resources
    this.#onError = onError
  }

  commit(): Promise<void> {
    return this.#settle('commit')
  }

  rollback(): Promise<void> {
    return this.#settlement ? Promise.resolve() : this.#settle('rollback')
  }

  fail(error: unknown): Promise<void> {
    return this.#settlement ? Promise.resolve() : this.#settle(isPreparedResourceResultUnknown(error) ? 'retain' : 'rollback')
  }

  #settle(outcome: 'commit' | 'rollback' | 'retain'): Promise<void> {
    this.#settlement ??= Promise.resolve().then(() => this.#resources?.[outcome]()).catch((error) => {
      try {
        this.#onError(error)
      }
      catch {}
    })
    return this.#settlement
  }
}
