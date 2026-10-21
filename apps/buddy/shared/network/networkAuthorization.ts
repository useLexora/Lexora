import type { RuntimeRpcPeerContract } from '../runtime/rpcPeer'
import { z } from 'zod'

export type NetworkOperation = 'access' | 'download' | 'upload'
export type NetworkAuthorizer = (url: string, operation?: NetworkOperation, signal?: AbortSignal) => Promise<void>

export const networkAuthorizationRequestSchema = z.object({
  requestId: z.uuid(),
  url: z.string().min(1).max(16 * 1024),
  operation: z.enum(['access', 'download', 'upload']),
}).strict()

export function createHostNetworkAuthorizer(peer: Pick<RuntimeRpcPeerContract, 'request'>, requestId: string | undefined, signal?: AbortSignal): NetworkAuthorizer {
  return async (url, operation = 'access', parent) => {
    const combined = AbortSignal.any([...(signal ? [signal] : []), ...(parent ? [parent] : [])])
    combined.throwIfAborted()
    if (!requestId)
      throw new Error('NETWORK_AUTHORIZATION_UNAVAILABLE')
    const result = await peer.request('runtime.network.authorize', { requestId, url, operation }, null, combined)
    combined.throwIfAborted()
    if (!z.object({ ok: z.literal(true) }).strict().safeParse(result).success)
      throw new Error('NETWORK_AUTHORIZATION_DENIED')
  }
}

export function isFileDownload(headers: Headers): boolean {
  const disposition = headers.get('content-disposition') ?? ''
  const type = (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  return /^attachment(?:;|$)/i.test(disposition.trim())
    || /(?:^|;)\s*filename\*?=/i.test(disposition)
    || ['application/pdf', 'application/octet-stream', 'application/zip', 'application/gzip'].includes(type)
}
