import type { Server } from 'node:net'
import type { ServiceHello, ServiceIdentity } from '../../shared/service/localServiceProtocol'
import type { LocalEndpoint } from '../ipc/localTransport'
import { Buffer } from 'node:buffer'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:net'
import { serviceHelloSchema, serviceIdentitySchema } from '../../shared/service/localServiceProtocol'
import { SocketFrames } from './SocketFrames'

interface LocalServiceServerOptions {
  endpoint: LocalEndpoint
  identity: ServiceIdentity
  role: ServiceHello['role']
  secret: string
  singleUse?: boolean
  connected: (frames: SocketFrames, connectionId: string) => void
}

export class LocalServiceServer {
  readonly #options: LocalServiceServerOptions
  readonly #connections = new Set<SocketFrames>()
  #server: Server | undefined
  #consumed = false
  #stopping = false

  constructor(options: LocalServiceServerOptions) {
    this.#options = { ...options, identity: serviceIdentitySchema.strip().parse(options.identity) }
  }

  async listen(): Promise<void> {
    if (this.#server || this.#stopping)
      throw new Error('SERVICE_LISTENER_STATE_INVALID')
    await this.#options.endpoint.prepare()
    const server = createServer((socket) => {
      if (this.#stopping || this.#connections.size >= 64 || (this.#options.singleUse && this.#consumed)) {
        socket.destroy()
        return
      }
      const frames = new SocketFrames(socket)
      this.#connections.add(frames)
      const timeout = setTimeout(() => frames.close(new Error('SERVICE_HANDSHAKE_TIMEOUT')), 5000)
      const stop = frames.onFrame((frame) => {
        const parsed = serviceHelloSchema.safeParse(JSON.parse(frame))
        const expected = this.#options
        if (!parsed.success || parsed.data.role !== expected.role || (expected.singleUse && this.#consumed)
          || Object.entries(expected.identity).some(([key, value]) => parsed.data[key as keyof ServiceIdentity] !== value)
          || !timingSafeEqual(Buffer.from(parsed.data.secret, 'hex'), Buffer.from(expected.secret, 'hex'))) {
          frames.close(new Error('SERVICE_HANDSHAKE_REJECTED'))
          return
        }
        this.#consumed = true
        clearTimeout(timeout)
        stop.dispose()
        const connectionId = randomUUID()
        if (!frames.send(JSON.stringify({ ...expected.identity, type: 'welcome', connectionId })))
          return
        try {
          expected.connected(frames, connectionId)
        }
        catch { frames.close(new Error('SERVICE_CONNECTION_FAILED')) }
      })
      frames.onDidClose(() => {
        clearTimeout(timeout)
        stop.dispose()
        this.#connections.delete(frames)
      })
    })
    server.on('error', () => {
      for (const frames of this.#connections) frames.close(new Error('SERVICE_LISTENER_FAILED'))
    })
    this.#server = server
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error)
        server.once('error', failed)
        server.listen(this.#options.endpoint.address, () => {
          server.off('error', failed)
          resolve()
        })
      })
      await this.#options.endpoint.secure()
    }
    catch (error) {
      await this.dispose()
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.#stopping)
      return
    this.#stopping = true
    for (const frames of this.#connections) frames.close(new Error('SERVICE_STOPPED'))
    if (this.#server?.listening)
      await new Promise<void>((resolve, reject) => this.#server!.close(error => error ? reject(error) : resolve()))
    await this.#options.endpoint.dispose()
  }
}
