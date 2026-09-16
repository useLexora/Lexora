import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { ProxyAuthenticator } from './requestThroughHost'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { session } from 'electron'
import { WebError, webError, webNetworkRequestSchema, webRenderCancelSchema, webRenderInputSchema } from '../../../shared/network/webProtocol'
import { HostWebNetwork } from './HostWebNetwork'
import { requestThroughHost } from './requestThroughHost'
import { renderWebDocument } from './WebRenderHost'

export function registerWebHostRpc(peer: RuntimeRpcPeerContract, authenticateProxy?: ProxyAuthenticator): () => void {
  const isolated = session.fromPartition(`buddy-web-network:${randomUUID()}`, { cache: false })
  isolated.setPermissionCheckHandler(() => false)
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const network = new HostWebNetwork(isolated, (session, input, signal) => requestThroughHost(session, input, signal, authenticateProxy))
  const active = new Map<string, AbortController>()
  let renders = 0
  let disposed = false
  const notify = (params: object) => {
    if (!disposed)
      peer.notify('host.web.chunk', params)
  }
  const begin = (id: string, timeout: number) => {
    if (disposed || active.has(id) || active.size >= 8)
      throw new WebError('WEB_BUSY')
    const controller = new AbortController()
    active.set(id, controller)
    return AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)])
  }
  const disposers = [
    peer.onNotification((method, params) => {
      if (method !== 'host.web.cancel')
        return
      const result = webRenderCancelSchema.safeParse(params)
      if (result.success)
        active.get(result.data.requestId)?.abort()
    }),
    peer.onRequest('host.web.authorize', async (params) => {
      const input = webRenderInputSchema.pick({ url: true }).parse(params)
      try {
        await network.authorizePublicUrl(input.url)
        return { ok: true }
      }
      catch (error) { return { ok: false, code: webError(error).code } }
    }),
    peer.onRequest('host.web.request', async (params) => {
      const input = webNetworkRequestSchema.parse(params)
      let signal: AbortSignal | undefined
      try {
        signal = begin(input.requestId, 60_000)
        const { response, url } = await network.fetch(input, signal)
        const body = response.body
        const executionSignal = signal
        void (async () => {
          const reader = body?.getReader()
          let length = 0
          try {
            if (reader) {
              while (true) {
                const value = await reader.read()
                if (value.done)
                  break
                executionSignal.throwIfAborted()
                length += value.value.byteLength
                if (length > input.limit)
                  throw new WebError('WEB_RESPONSE_TOO_LARGE')
                for (let offset = 0; offset < value.value.byteLength; offset += 64 * 1024)
                  notify({ requestId: input.requestId, chunk: Buffer.from(value.value.subarray(offset, offset + 64 * 1024)).toString('base64') })
              }
            }
            notify({ requestId: input.requestId, done: true })
          }
          catch (error) { notify({ requestId: input.requestId, code: webError(error, executionSignal).code }) }
          finally {
            await reader?.cancel().catch(() => {})
            reader?.releaseLock()
            active.delete(input.requestId)
          }
        })().catch(() => {})
        const headers = new Headers(response.headers)
        for (const key of ['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding'])
          headers.delete(key)
        return { ok: true, status: response.status, headers: Object.fromEntries(headers), url }
      }
      catch (error) {
        active.delete(input.requestId)
        return { ok: false, code: webError(error, signal).code }
      }
    }),
    peer.onRequest('host.web.render', async (params) => {
      const input = webRenderInputSchema.parse(params)
      if (renders >= 2)
        return { ok: false, code: 'WEB_BUSY' }
      let signal: AbortSignal | undefined
      renders++
      try {
        signal = begin(input.requestId, 20_000)
        return { ok: true, ...await renderWebDocument(network, input.url, signal) }
      }
      catch (error) { return { ok: false, code: webError(error, signal).code } }
      finally {
        renders--
        active.delete(input.requestId)
      }
    }),
  ]
  return () => {
    disposed = true
    disposers.forEach(dispose => dispose())
    for (const controller of active.values())
      controller.abort()
    active.clear()
    void Promise.allSettled([isolated.closeAllConnections(), isolated.clearStorageData(), isolated.clearCache()])
  }
}
