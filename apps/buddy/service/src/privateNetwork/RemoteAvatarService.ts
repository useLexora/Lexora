import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import type { TrustedCommandPrincipal } from '../commands/CommandAdmissionService'
import { PrivateNetworkError } from '../../../shared/privateNetwork/pairing'
import { productIdSchema } from '../../../shared/productProtocol/scalars'
import { ProductBuddyAvatars } from '../productProtocol/ProductBuddyAvatars'

export class RemoteAvatarService {
  readonly #avatars: ProductBuddyAvatars
  constructor(database: DatabaseSync) { this.#avatars = new ProductBuddyAvatars(database) }

  bytes(request: IncomingMessage, response: ServerResponse, principal: TrustedCommandPrincipal): boolean {
    const match = /^\/v1\/avatars\/([^/]+)\/([a-f0-9]{64})$/.exec(request.url ?? '')
    if (!match)
      return false
    if (request.method !== 'GET' && request.method !== 'HEAD')
      throw new PrivateNetworkError('INVALID_REQUEST')
    let buddyId: string
    try {
      buddyId = productIdSchema.parse(decodeURIComponent(match[1]!))
    }
    catch { throw new PrivateNetworkError('INVALID_REQUEST') }
    principal.assertAuthenticated()
    const { avatar, bytes } = this.#avatars.read(buddyId)
    if (avatar.kind !== 'image' || !bytes)
      throw new PrivateNetworkError('RESOURCE_UNAVAILABLE')
    if (avatar.sha256 !== match[2])
      throw new PrivateNetworkError('VERSION_CHANGED')
    response.setHeader('Content-Type', avatar.mimeType)
    response.setHeader('Content-Length', bytes.length)
    response.setHeader('ETag', `"${avatar.sha256}"`)
    response.end(request.method === 'HEAD' ? undefined : bytes)
    return true
  }
}
