import type { RuntimeWireMessage } from '../../../../shared/runtime/runtimeProtocol'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeRpcPeer } from '../../../../platform/ipc/runtimeRpcPeer'
import { createHostNetworkAuthorizer } from '../../../../shared/network/networkAuthorization'
import { beginNetworkRequest, requestWithNetworkAuthorization, withNetworkAuthorization } from '../networkAuthorizationContext'

const peers: RuntimeRpcPeer[] = []
afterEach(() => {
  for (const peer of peers.splice(0))
    peer.close(new Error('test finished'))
})

function pair() {
  let receiveService: (message: unknown) => void = () => {}
  let receiveHost: (message: unknown) => void = () => {}
  const service = new RuntimeRpcPeer({ transport: {
    postMessage: (message: RuntimeWireMessage) => queueMicrotask(() => receiveHost(message)),
    subscribe(listener) {
      receiveService = listener
      return () => {}
    },
  } })
  const host = new RuntimeRpcPeer({ transport: {
    postMessage: (message: RuntimeWireMessage) => queueMicrotask(() => receiveService(message)),
    subscribe(listener) {
      receiveHost = listener
      return () => {}
    },
  } })
  peers.push(service, host)
  return { service, host }
}

describe('private network authorization callbacks', () => {
  it('uses the transport request identity and the trusted tool closure rather than model parameters', async () => {
    const { service, host } = pair()
    const targets: string[] = []
    host.onRequest('host.test', async (_params, signal, requestId) => {
      await createHostNetworkAuthorizer(host, requestId, signal)('https://redirect.example/resource', 'download')
      return 'transferred'
    })
    const result = await withNetworkAuthorization({
      toolCallId: 'trusted-call',
      toolName: 'lexora_web_fetch',
      authorizeNetwork: async (input) => { targets.push(`${input.toolCallId}:${input.toolName}:${input.operation}:${input.url}`) },
    }, () => requestWithNetworkAuthorization(service, 'host.test', { requestId: randomUUID(), toolCallId: 'forged' }))
    expect(result).toBe('transferred')
    expect(targets).toEqual(['trusted-call:lexora_web_fetch:download:https://redirect.example/resource'])
  })

  it('rejects unknown and expired request IDs without invoking another tool authorizer', async () => {
    const { service, host } = pair()
    const request = beginNetworkRequest(service)
    const params = { requestId: request.requestId, url: 'https://example.com', operation: 'access' }
    request.dispose()
    await expect(host.request('runtime.network.authorize', params)).resolves.toEqual({ ok: false })
    await expect(host.request('runtime.network.authorize', { ...params, requestId: randomUUID() })).resolves.toEqual({ ok: false })
  })

  it('preserves the original denial and prevents the host operation from passing its gate', async () => {
    const { service, host } = pair()
    const denied = Object.assign(new Error('domain denied'), { toolCallBlockReason: 'NETWORK_PERMISSION_DENIED' })
    let transferred = false
    host.onRequest('host.test', async (_params, signal, requestId) => {
      try {
        await createHostNetworkAuthorizer(host, requestId, signal)('https://denied.example/')
        transferred = true
        return true
      }
      catch { return false }
    })
    await expect(withNetworkAuthorization({
      toolCallId: 'call',
      toolName: 'lexora_browser_open',
      authorizeNetwork: async () => { throw denied },
    }, () => requestWithNetworkAuthorization(service, 'host.test', {}))).rejects.toBe(denied)
    expect(transferred).toBe(false)
  })

  it('cancels a waiting decision even when the authorization implementation never settles', async () => {
    const { service, host } = pair()
    const started = Promise.withResolvers<void>()
    const controller = new AbortController()
    let transferred = false
    host.onRequest('host.test', async (_params, signal, requestId) => {
      await createHostNetworkAuthorizer(host, requestId, signal)('https://example.com/')
      transferred = true
    })
    const running = withNetworkAuthorization({
      toolCallId: 'call',
      toolName: 'lexora_browser_open',
      signal: controller.signal,
      authorizeNetwork: async () => {
        started.resolve()
        await new Promise<void>(() => {})
      },
    }, () => requestWithNetworkAuthorization(service, 'host.test', {}))
    const rejected = expect(running).rejects.toThrow()
    await started.promise
    controller.abort()
    await rejected
    expect(transferred).toBe(false)
  })

  it('keeps concurrent tool callbacks isolated on the same peer', async () => {
    const { service, host } = pair()
    const targets = new Map<string, string[]>()
    host.onRequest('host.test', async (params, signal, requestId) => {
      await createHostNetworkAuthorizer(host, requestId, signal)(String(params))
      return true
    })
    await Promise.all(['one', 'two'].map(toolCallId => withNetworkAuthorization({
      toolCallId,
      toolName: 'lexora_web_fetch',
      authorizeNetwork: async (input) => {
        targets.set(input.toolCallId, [...targets.get(input.toolCallId) ?? [], input.url])
      },
    }, () => requestWithNetworkAuthorization(service, 'host.test', `https://${toolCallId}.example/`))))
    expect(Object.fromEntries(targets)).toEqual({ one: ['https://one.example/'], two: ['https://two.example/'] })
  })
})
