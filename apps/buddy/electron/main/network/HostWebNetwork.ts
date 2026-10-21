import type { Session } from 'electron'
import type { NetworkAuthorizer } from '../../../shared/network/networkAuthorization'
import type { WebNetworkRequest } from '../../../shared/network/webProtocol'
import { publicWebUrl } from '../../../platform/network/publicWebTransport'
import { isFileDownload } from '../../../shared/network/networkAuthorization'
import { WebError } from '../../../shared/network/webProtocol'
import { requestThroughHost } from './requestThroughHost'

export class HostWebNetwork {
  readonly session: Session
  readonly #request: typeof requestThroughHost

  constructor(session: Session, request: typeof requestThroughHost = requestThroughHost) {
    this.session = session
    this.#request = request
  }

  async authorizePublicUrl(raw: string): Promise<URL> {
    return publicWebUrl(raw)
  }

  async fetch(input: Pick<WebNetworkRequest, 'body' | 'headers' | 'method' | 'scope' | 'url'>, signal: AbortSignal, options: { redirect?: 'manual', authorize: NetworkAuthorizer }): Promise<{ response: Response, url: string }> {
    let url = new URL(input.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new WebError('WEB_URL_BLOCKED')
    if (input.scope === 'public' && (input.method !== 'GET' || input.body !== undefined))
      throw new WebError('WEB_URL_BLOCKED')
    for (let redirect = 0; redirect <= 5; redirect++) {
      signal.throwIfAborted()
      if (input.scope === 'public')
        url = await this.authorizePublicUrl(url.href)
      await options.authorize(url.href, 'access', signal)
      signal.throwIfAborted()
      const response = await this.#request(this.session, { ...input, url: url.href }, signal)
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (input.scope !== 'public' || !location)
          throw new WebError('WEB_HTTP_ERROR', response.status)
        const target = new URL(location, url)
        if (options?.redirect === 'manual') {
          await this.authorizePublicUrl(target.href)
          return { response: new Response(null, { status: response.status, headers: { location: target.href } }), url: url.href }
        }
        url = target
        continue
      }
      try {
        signal.throwIfAborted()
        if (isFileDownload(response.headers))
          await options.authorize(url.href, 'download', signal)
        signal.throwIfAborted()
        return { response, url: url.href }
      }
      catch (error) {
        await response.body?.cancel().catch(() => {})
        throw error
      }
    }
    throw new WebError('WEB_INVALID_RESPONSE')
  }
}
