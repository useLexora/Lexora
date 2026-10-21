import type { NetworkAuthorizer } from '../../../shared/network/networkAuthorization'

export class BrowserNetworkAuthorization {
  #current: { authorize: NetworkAuthorizer, controller: AbortController, signal: AbortSignal } | null = null

  readonly authorize: NetworkAuthorizer = async (url, operation = 'access', signal) => {
    const current = this.#current
    if (!current)
      return
    current.signal.throwIfAborted()
    await current.authorize(url, operation, AbortSignal.any([current.signal, ...(signal ? [signal] : [])]))
    current.signal.throwIfAborted()
    if (this.#current !== current)
      throw new Error('BROWSER_NETWORK_CONTEXT_CHANGED')
  }

  async run<T>(authorize: NetworkAuthorizer, signal: AbortSignal | undefined, operation: () => Promise<T>, stop: () => void): Promise<T> {
    if (this.#current && !this.#current.signal.aborted)
      throw new Error('BROWSER_NETWORK_OPERATION_BUSY')
    const controller = new AbortController()
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
    let failure: unknown
    const current = {
      controller,
      signal: combined,
      authorize: async (...args: Parameters<NetworkAuthorizer>) => {
        try {
          await authorize(...args)
        }
        catch (error) {
          failure ??= error
          throw error
        }
      },
    }
    this.#current = current
    combined.addEventListener('abort', stop, { once: true })
    try {
      combined.throwIfAborted()
      const result = await operation()
      if (failure)
        throw failure
      combined.throwIfAborted()
      return result
    }
    finally {
      combined.removeEventListener('abort', stop)
      controller.abort()
    }
  }

  requireAgentAuthorization(): void {
    if (this.#current)
      return
    const controller = new AbortController()
    controller.abort()
    this.#current = {
      controller,
      signal: controller.signal,
      authorize: async () => {
        throw new Error('NETWORK_AUTHORIZATION_UNAVAILABLE')
      },
    }
  }

  useHumanControl(): void {
    this.#current?.controller.abort()
    this.#current = null
  }

  dispose(): void {
    this.#current?.controller.abort()
  }
}
