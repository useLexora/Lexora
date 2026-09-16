import type { AuthInfo, Session } from 'electron'
import type { WebNetworkRequest } from '../../../shared/network/webProtocol'
import { WebError } from '../../../shared/network/webProtocol'

export type ProxyAuthenticator = (authInfo: AuthInfo, callback: (username?: string, password?: string) => void) => boolean

export async function requestThroughHost(session: Session, input: Pick<WebNetworkRequest, 'body' | 'headers' | 'method' | 'url'>, signal: AbortSignal, authenticateProxy?: ProxyAuthenticator): Promise<Response> {
  const { net } = await import('electron')
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const request = net.request({ url: input.url, method: input.method, session, redirect: 'manual', credentials: 'omit', useSessionCookies: false })
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    let ended = false
    function cleanup() {
      signal.removeEventListener('abort', abort)
    }
    function fail(error: unknown) {
      if (ended)
        return
      ended = true
      cleanup()
      stream?.error(error)
      reject(error)
    }
    function abort() {
      fail(signal.reason ?? new WebError('WEB_CANCELLED'))
      request.abort()
    }
    signal.addEventListener('abort', abort, { once: true })
    request.on('error', fail)
    request.on('login', (auth, callback) => {
      if (!authenticateProxy?.(auth, callback))
        callback()
    })
    request.on('redirect', (status, _method, target) => {
      ended = true
      cleanup()
      resolve(new Response(null, { status, headers: { location: target } }))
      request.abort()
    })
    request.on('response', (incoming) => {
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined && !['set-cookie', 'content-length', 'content-encoding', 'transfer-encoding'].includes(key.toLowerCase()))
          headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) { stream = controller },
        cancel() {
          ended = true
          cleanup()
          request.abort()
        },
      })
      incoming.on('data', (chunk: Uint8Array) => {
        if (!ended)
          stream!.enqueue(chunk)
      })
      incoming.on('error', fail)
      incoming.on('aborted', () => fail(new WebError('WEB_NETWORK_ERROR')))
      incoming.on('end', () => {
        if (!ended) {
          ended = true
          stream!.close()
          cleanup()
        }
      })
      resolve(new Response([204, 205, 304].includes(incoming.statusCode) ? null : body, { status: incoming.statusCode, headers }))
    })
    try {
      for (const [key, value] of Object.entries(input.headers))
        request.setHeader(key, value)
      if (input.body !== undefined)
        request.write(input.body)
      request.end()
    }
    catch (error) {
      fail(error)
      request.abort()
    }
  })
}
