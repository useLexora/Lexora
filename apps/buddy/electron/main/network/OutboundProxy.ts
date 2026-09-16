import type { lookup } from 'node:dns'
import type { ProxySettings } from '../../../shared/network/proxySettings'
import { randomBytes } from 'node:crypto'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { createResolvedAddressGuard } from '@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js'
import { RequestError, Server } from 'proxy-chain'

export class OutboundProxy {
  readonly username = 'lexora'
  readonly password = randomBytes(32).toString('hex')
  readonly #sandboxPassword = randomBytes(32).toString('hex')
  readonly #server: Server
  readonly #httpAgent = new HttpAgent({ keepAlive: true })
  readonly #httpsAgent = new HttpsAgent({ keepAlive: true })
  readonly #sandboxHttpAgent = new HttpAgent({ keepAlive: false })
  readonly #resolve: (url: string) => Promise<string>
  #generation = 0
  readonly #sandboxGuard = createResolvedAddressGuard({ deniedResolvedAddresses: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7'] })

  constructor(resolve: (url: string) => Promise<string>) {
    this.#resolve = resolve
    this.#server = new Server({
      host: '127.0.0.1',
      port: 0,
      verbose: false,
      prepareRequestFunction: async ({ username, password, request, hostname, port, isHttp }) => {
        const identity = username.replace(/-http$/, '')
        const sandbox = identity === 'lexora-sandbox'
        if (![this.username, 'lexora-sandbox'].includes(identity) || password !== (sandbox ? this.#sandboxPassword : this.password))
          return { requestAuthentication: true }
        if (port === this.port && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname))
          throw new RequestError('Proxy loop', 502)
        const generation = this.#generation
        const authority = `${hostname}:${port}`
        const protocol = username.endsWith('-http') ? 'http' : 'https'
        const url = isHttp ? request.url! : `${protocol}://${authority}/`
        const upstreamProxyUrl = resolveUpstreamProxy(await this.#resolve(url))
        if (generation !== this.#generation)
          throw new RequestError('Proxy configuration changed', 503)
        return {
          upstreamProxyUrl,
          httpAgent: sandbox ? this.#sandboxHttpAgent : this.#httpAgent,
          httpsAgent: this.#httpsAgent,
          ...(sandbox && !upstreamProxyUrl ? { dnsLookup: this.#sandboxGuard.lookupFor(port) as typeof lookup } : {}),
        }
      },
    })
  }

  get port(): number { return this.#server.port }
  get url(): string { return `http://${this.username}:${this.password}@127.0.0.1:${this.port}` }
  get sandboxUrl(): string { return `http://lexora-sandbox:${this.#sandboxPassword}@127.0.0.1:${this.port}` }
  get address(): string { return `http://127.0.0.1:${this.port}` }

  async start(): Promise<void> {
    await this.#server.listen()
  }

  disconnect(): void {
    this.#generation++
    this.#server.closeConnections()
    this.#httpAgent.destroy()
    this.#httpsAgent.destroy()
    this.#sandboxHttpAgent.destroy()
  }

  async stop(): Promise<void> {
    this.disconnect()
    await this.#server.close(true)
  }
}

export function resolveUpstreamProxy(result: string): string | undefined {
  const first = result.split(';')[0]?.trim()
  if (first === 'DIRECT')
    return undefined
  const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/.exec(first ?? '')
  if (!match)
    throw new RequestError('Unsupported system proxy', 502)
  const protocols: Record<string, string> = { PROXY: 'http', HTTPS: 'https', SOCKS: 'socks4a', SOCKS4: 'socks4a', SOCKS5: 'socks5h' }
  return `${protocols[match[1]!]}://${match[2]}`
}

export function toElectronProxyConfig(settings: ProxySettings): Electron.ProxyConfig {
  if (settings.mode === 'custom') {
    const server = new URL(settings.server)
    return { mode: 'fixed_servers', proxyRules: `${server.protocol}//${server.host}` }
  }
  return { mode: settings.mode }
}
