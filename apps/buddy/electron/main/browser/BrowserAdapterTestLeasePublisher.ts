import type { Socket } from 'node:net'
import type {
  BrowserAdapterIssueLeaseParams,
  BrowserAdapterLease,
} from '../../../shared/browser/browserAdapterProtocol'
import type { DesktopBrowserState } from '../../../shared/browser/browserDesktopApi'
import { createConnection } from 'node:net'
import { isAbsolute } from 'node:path'
import { BROWSER_ADAPTER_MAX_LEASE_TTL_MS } from '../../../shared/browser/browserAdapterProtocol'

interface BrowserAdapterTestLeasePublisherOptions {
  brokerSocketPath: string
  issueLease: (input: BrowserAdapterIssueLeaseParams) => BrowserAdapterLease
}

export class BrowserAdapterTestLeasePublisher {
  readonly #brokerSocketPath: string
  readonly #issueLease: BrowserAdapterTestLeasePublisherOptions['issueLease']
  readonly #publishedSessionIds = new Set<string>()
  readonly #sockets = new Set<Socket>()

  constructor(options: BrowserAdapterTestLeasePublisherOptions) {
    if (!isAbsolute(options.brokerSocketPath))
      throw new Error('Browser adapter test broker socket must be an absolute path')
    this.#brokerSocketPath = options.brokerSocketPath
    this.#issueLease = options.issueLease
  }

  publish(state: DesktopBrowserState): void {
    if (!state.conversationId || state.status !== 'ready' || this.#publishedSessionIds.has(state.sessionId))
      return
    this.#publishedSessionIds.add(state.sessionId)
    let lease: BrowserAdapterLease
    try {
      lease = this.#issueLease({
        conversationId: state.conversationId,
        ttlMs: BROWSER_ADAPTER_MAX_LEASE_TTL_MS,
      })
    }
    catch {
      this.#publishedSessionIds.delete(state.sessionId)
      return
    }

    const socket = createConnection(this.#brokerSocketPath)
    this.#sockets.add(socket)
    socket.once('connect', () => socket.end(`${JSON.stringify(lease)}\n`))
    socket.once('error', () => {
      this.#publishedSessionIds.delete(state.sessionId)
    })
    socket.once('close', () => this.#sockets.delete(socket))
  }

  dispose(): void {
    for (const socket of this.#sockets)
      socket.destroy()
    this.#sockets.clear()
    this.#publishedSessionIds.clear()
  }
}
