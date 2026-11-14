import { AsyncOperationScope } from '../../shared/lifecycle/AsyncOperationScope'

export class ExtensionInvocationScope {
  readonly abort = new AbortController()
  readonly signal: AbortSignal
  readonly #operations = new AsyncOperationScope(() => new Error('EXTENSION_INVOCATION_EXPIRED'))

  constructor(signals: AbortSignal[]) {
    this.signal = AbortSignal.any([...signals, this.abort.signal])
  }

  track<T>(operation: () => Promise<T>): Promise<T> {
    return this.#operations.track(operation)
  }

  async finish(): Promise<void> {
    this.#operations.stopAccepting()
    this.abort.abort()
    await this.#operations.drain()
  }
}
