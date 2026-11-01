import type { RuntimePreferences } from '../../../../shared/runtime/runtimePreferences'
import { DEFAULT_RUNTIME_PREFERENCES } from '../../../../shared/runtime/runtimePreferences'

type Preferences = Pick<RuntimePreferences, 'codemodeWorkerLimit' | 'codemodeOverflow'>
type ReleaseWorker = () => void

interface Waiter {
  admit: () => void
  reject: (error: unknown) => void
}

export class CodemodeWorkerPool {
  #preferences: Preferences = DEFAULT_RUNTIME_PREFERENCES
  #active = 0
  #waiters: Waiter[] = []
  #disposed = false

  configure(preferences: Preferences): void {
    this.#preferences = { codemodeWorkerLimit: preferences.codemodeWorkerLimit, codemodeOverflow: preferences.codemodeOverflow }
    this.#admit()
  }

  acquire(signal?: AbortSignal, onQueued?: () => void): Promise<ReleaseWorker> {
    if (signal?.aborted)
      return Promise.reject(signal.reason)
    if (this.#disposed)
      return Promise.reject(new Error('CodeMode execution is stopping.'))
    if (!this.#waiters.length && this.#hasCapacity())
      return Promise.resolve(this.#reserve())
    if (this.#preferences.codemodeOverflow === 'reject')
      return Promise.reject(new Error(`CodeMode capacity is full (${this.#active} scripts). Wait for a running script to finish or change the concurrency settings.`))
    const waiters = this.#waiters
    return new Promise<ReleaseWorker>((resolve, reject) => {
      const waiter: Waiter = {
        admit: () => {
          remove()
          resolve(this.#reserve())
        },
        reject: (error) => {
          remove()
          reject(error)
        },
      }
      const abort = () => waiter.reject(signal?.reason)
      function remove() {
        signal?.removeEventListener('abort', abort)
        const index = waiters.indexOf(waiter)
        if (index >= 0)
          waiters.splice(index, 1)
      }
      this.#waiters.push(waiter)
      signal?.addEventListener('abort', abort, { once: true })
      try {
        onQueued?.()
      }
      catch (error) {
        waiter.reject(error)
      }
    })
  }

  dispose(): void {
    this.#disposed = true
    for (const waiter of [...this.#waiters])
      waiter.reject(new Error('CodeMode execution is stopping.'))
  }

  #hasCapacity(): boolean {
    return this.#preferences.codemodeWorkerLimit === 'unlimited' || this.#active < this.#preferences.codemodeWorkerLimit
  }

  #reserve(): ReleaseWorker {
    this.#active++
    let released = false
    return () => {
      if (released)
        return
      released = true
      this.#active--
      this.#admit()
    }
  }

  #admit(): void {
    while (!this.#disposed && this.#waiters.length && this.#hasCapacity())
      this.#waiters[0]!.admit()
  }
}
