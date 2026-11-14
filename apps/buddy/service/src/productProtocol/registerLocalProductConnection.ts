import type { ServiceClientPeer } from '../rpc/ServiceClientConnections'
import type { ProductConnection } from './ProductConnection'
import { productExchange, productFrameNotification } from '../../../shared/productProtocol/transport'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export function registerLocalProductConnection(peer: ServiceClientPeer, create: (transport: { send: (frame: string) => boolean, close: () => void }) => ProductConnection): () => void {
  const connection = create({
    send(frame) {
      if (peer.closed)
        return false
      peer.notify(productFrameNotification.method, { frame })
      return true
    },
    close: () => peer.close(new Error('PRODUCT_CONNECTION_CLOSED')),
  })
  const unregister = registerRuntimeRequest(peer, productExchange, async ({ frame }) => {
    await connection.receive(frame)
    return { received: true as const }
  })
  const closed = peer.onDidClose(() => connection.close())
  return () => {
    unregister()
    closed.dispose()
    connection.close()
  }
}
