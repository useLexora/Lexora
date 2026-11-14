import type { ServiceHello } from '../../shared/service/localServiceProtocol'
import { createConnection } from 'node:net'
import { serviceHelloSchema, serviceWelcomeSchema } from '../../shared/service/localServiceProtocol'
import { SocketFrames } from './SocketFrames'

export function connectLocalService(address: string, hello: ServiceHello, signal?: AbortSignal): Promise<{ frames: SocketFrames, connectionId: string }> {
  const input = serviceHelloSchema.parse(hello)
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const socket = createConnection(address)
    const frames = new SocketFrames(socket)
    const timeout = setTimeout(() => frames.close(new Error('SERVICE_HANDSHAKE_TIMEOUT')), 5000)
    const abort = () => frames.close(new Error('SERVICE_CONNECTION_CANCELLED'))
    signal?.addEventListener('abort', abort, { once: true })
    const received = frames.onFrame((frame) => {
      const welcome = serviceWelcomeSchema.safeParse(JSON.parse(frame))
      if (!welcome.success || ['protocol', 'profileId', 'serviceInstanceId', 'buildId', 'sessionId', 'userId'].some(key => welcome.data[key as keyof typeof welcome.data] !== input[key as keyof ServiceHello])) {
        frames.close(new Error('SERVICE_HANDSHAKE_REJECTED'))
        return
      }
      frames.pause()
      cleanup()
      resolve({ frames, connectionId: welcome.data.connectionId })
    })
    const closed = frames.onDidClose((error) => {
      cleanup()
      reject(error)
    })
    function cleanup() {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      received.dispose()
      closed.dispose()
    }
    socket.once('connect', () => frames.send(JSON.stringify(input)))
  })
}
