import type { NetworkAuthorizer } from '../../../shared/network/networkAuthorization'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { BuddyCapabilityContext } from '../agent/extensions/BuddyCapability'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { networkAuthorizationRequestSchema } from '../../../shared/network/networkAuthorization'

const authorization = new AsyncLocalStorage<NetworkAuthorizer & { signal: AbortSignal }>()
type Peer = Pick<RuntimeRpcPeerContract, 'request'> & Partial<Pick<RuntimeRpcPeerContract, 'onRequest'>>
const registries = new WeakMap<Peer, Map<string, NetworkAuthorizer>>()

export function throwIfNetworkAuthorizationFailed(error: unknown): void {
  if (typeof error === 'object' && error !== null && 'toolCallBlockReason' in error)
    throw error
}

function unavailable(): Error {
  return Object.assign(new Error('NETWORK_AUTHORIZATION_UNAVAILABLE'), { toolCallBlockReason: 'APPROVAL_REQUIRED' })
}

export async function withNetworkAuthorization<T>(
  input: { authorizeNetwork?: BuddyCapabilityContext['authorizeNetwork'], toolCallId: string, toolName: string, signal?: AbortSignal },
  operation: () => Promise<T>,
): Promise<T> {
  const lifetime = new AbortController()
  const signal = AbortSignal.any([lifetime.signal, ...(input.signal ? [input.signal] : [])])
  let failure: unknown
  const authorize: NetworkAuthorizer = async (url, operation = 'access', parent) => {
    try {
      const requestSignal = AbortSignal.any([signal, ...(parent ? [parent] : [])])
      requestSignal.throwIfAborted()
      if (!input.authorizeNetwork)
        throw unavailable()
      await waitForNetworkAuthorization(input.authorizeNetwork({ toolCallId: input.toolCallId, toolName: input.toolName, url, operation, signal: requestSignal }), requestSignal)
      requestSignal.throwIfAborted()
    }
    catch (error) {
      failure ??= error
      throw error
    }
  }
  try {
    const result = await authorization.run(Object.assign(authorize, { signal }), operation)
    if (failure)
      throw failure
    signal.throwIfAborted()
    return result
  }
  catch (error) {
    throw failure ?? error
  }
  finally { lifetime.abort() }
}

export function beginNetworkRequest(peer: Peer, parent?: AbortSignal) {
  let registry = registries.get(peer)
  if (!registry) {
    registry = new Map()
    const requests = registry
    peer.onRequest?.('runtime.network.authorize', async (params, signal) => {
      const input = networkAuthorizationRequestSchema.parse(params)
      const authorize = requests.get(input.requestId)
      if (!authorize)
        return { ok: false }
      try {
        await authorize(input.url, input.operation, signal)
        return { ok: true }
      }
      catch { return { ok: false } }
    })
    registries.set(peer, registry)
  }
  const requestId = randomUUID()
  const authorize = authorization.getStore()
  const lifetime = new AbortController()
  const signal = AbortSignal.any([lifetime.signal, ...(parent ? [parent] : []), ...(authorize ? [authorize.signal] : [])])
  let failure: unknown
  registry.set(requestId, async (url, operation, hostSignal) => {
    try {
      signal.throwIfAborted()
      if (!authorize || !peer.onRequest)
        throw unavailable()
      await authorize(url, operation, AbortSignal.any([signal, ...(hostSignal ? [hostSignal] : [])]))
      signal.throwIfAborted()
    }
    catch (error) {
      failure ??= error
      throw error
    }
  })
  return {
    requestId,
    signal,
    check() {
      if (failure)
        throw failure
      signal.throwIfAborted()
    },
    dispose() {
      registry.delete(requestId)
      lifetime.abort()
    },
  }
}

export async function requestWithNetworkAuthorization(peer: Peer, method: string, params: unknown): Promise<unknown> {
  const request = beginNetworkRequest(peer)
  try {
    const result = await peer.request(method, params, null, request.signal, request.requestId)
    request.check()
    return result
  }
  finally { request.dispose() }
}

async function waitForNetworkAuthorization(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    await Promise.race([promise, cancelled])
  }
  finally { signal.removeEventListener('abort', abort) }
}
