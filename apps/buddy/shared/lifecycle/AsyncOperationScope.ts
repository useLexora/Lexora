export class AsyncOperationScope {
  readonly #pending = new Set<Promise<unknown>>()
  readonly #unavailable: () => unknown
  #accepting = true

  constructor(unavailable: () => unknown) {
    this.#unavailable = unavailable
  }

  get isAccepting(): boolean {
    return this.#accepting
  }

  get hasPending(): boolean {
    return this.#pending.size > 0
  }

  assertAccepting(): void {
    if (!this.#accepting)
      throw this.#unavailable()
  }

  track<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    if (!this.#accepting)
      return Promise.reject(this.#unavailable())
    const pending = Promise.withResolvers<T>()
    this.#pending.add(pending.promise)
    const complete = (settle: () => void) => {
      this.#pending.delete(pending.promise)
      settle()
    }
    try {
      void Promise.resolve(operation()).then(
        value => complete(() => pending.resolve(value)),
        error => complete(() => pending.reject(error)),
      )
    }
    catch (error) {
      complete(() => pending.reject(error))
    }
    return pending.promise
  }

  stopAccepting(): void {
    this.#accepting = false
  }

  async drain(): Promise<void> {
    while (this.#pending.size)
      await Promise.allSettled([...this.#pending])
  }
}
