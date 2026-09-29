import { extensionAgentInvocationLimits } from '../../../shared/extensions/extensionAgent'

interface WaitingInvocation {
  extensionId: string
  start: (release: () => void) => void
}

export class ExtensionInvocationQueue {
  readonly #active = new Map<string, string>()
  readonly #waiting = new Map<string, WaitingInvocation>()

  acquire(extensionId: string, invocationId: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.#active.has(invocationId) || this.#waiting.has(invocationId) || this.#waiting.size >= extensionAgentInvocationLimits.queued)
      return Promise.reject(new Error('EXTENSION_REQUEST_LIMIT'))
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.#waiting.delete(invocationId)
        reject(signal.reason)
      }
      this.#waiting.set(invocationId, {
        extensionId,
        start: (release) => {
          signal.removeEventListener('abort', cancel)
          resolve(release)
        },
      })
      signal.addEventListener('abort', cancel, { once: true })
      this.#drain()
    })
  }

  #drain(): void {
    for (const [invocationId, waiting] of this.#waiting) {
      if (this.#active.size >= extensionAgentInvocationLimits.concurrent)
        break
      if ([...this.#active.values()].filter(id => id === waiting.extensionId).length >= extensionAgentInvocationLimits.concurrentPerExtension)
        continue
      this.#waiting.delete(invocationId)
      this.#active.set(invocationId, waiting.extensionId)
      waiting.start(() => {
        if (this.#active.delete(invocationId))
          this.#drain()
      })
    }
  }
}
