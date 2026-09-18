export type Cleanup = () => void

export class DisposableScope {
  readonly #controller = new AbortController()
  readonly #cleanups = new Set<Cleanup>()

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  add(cleanup: Cleanup): Cleanup {
    if (this.signal.aborted) {
      cleanup()
      return () => {}
    }
    let active = true
    const dispose = () => {
      if (!active)
        return
      active = false
      this.#cleanups.delete(dispose)
      cleanup()
    }
    this.#cleanups.add(dispose)
    return dispose
  }

  child(): DisposableScope {
    const child = new DisposableScope()
    const remove = this.add(() => child.dispose())
    child.signal.addEventListener('abort', () => this.#cleanups.delete(remove), { once: true })
    return child
  }

  dispose(): void {
    if (this.signal.aborted)
      return
    this.#controller.abort()
    const failures: unknown[] = []
    for (const cleanup of [...this.#cleanups].reverse()) {
      try {
        cleanup()
      }
      catch (error) {
        failures.push(error)
      }
    }
    this.#cleanups.clear()
    if (failures.length)
      throw new AggregateError(failures, 'Scope cleanup failed')
  }
}
