import { EnvHttpProxyAgent, install, setGlobalDispatcher } from 'undici'

export interface RuntimeProxy {
  httpProxy: string
  httpsProxy: string
  noProxy: string
}

export function readRuntimeProxy(environment: Record<string, string | undefined>): RuntimeProxy {
  return {
    httpProxy: environment.http_proxy ?? environment.HTTP_PROXY ?? '',
    httpsProxy: environment.https_proxy ?? environment.HTTPS_PROXY ?? '',
    noProxy: environment.no_proxy ?? environment.NO_PROXY ?? '',
  }
}

export class RuntimeNetwork {
  #dispatcher: EnvHttpProxyAgent | undefined
  #disposed = false
  #disposing: Promise<void> | undefined
  readonly #retiring = new Set<Promise<void>>()

  async replace(proxy: RuntimeProxy): Promise<void> {
    if (this.#disposed)
      throw new Error('RUNTIME_NETWORK_STOPPED')
    const dispatcher = new EnvHttpProxyAgent({ ...proxy, allowH2: false, proxyTunnel: true })
    const previous = this.#dispatcher
    this.#dispatcher = dispatcher
    setGlobalDispatcher(dispatcher)
    install()
    await this.#release(previous)
  }

  async invalidate(): Promise<void> {
    const dispatcher = this.#dispatcher
    this.#dispatcher = undefined
    await this.#release(dispatcher)
    await Promise.all([...this.#retiring])
  }

  dispose(): Promise<void> {
    this.#disposed = true
    return this.#disposing ??= this.invalidate()
  }

  async #release(dispatcher?: EnvHttpProxyAgent): Promise<void> {
    if (!dispatcher)
      return
    const closing = dispatcher.destroy()
    this.#retiring.add(closing)
    try {
      await closing
    }
    finally {
      this.#retiring.delete(closing)
    }
  }
}
