import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Server } from 'node:https'
import type { Socket } from 'node:net'
import type { ProductConnection } from '../productProtocol/ProductConnection'
import type { AuthenticatedDevice, DeviceAuthorizationService } from './DeviceAuthorizationService'
import type { PrivateNetworkTlsIdentity } from './PrivateNetworkTlsIdentity'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:https'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import { PRIVATE_NETWORK_LIMITS as limits } from '../../../shared/privateNetwork/limits'
import { pairingConfirmSchema, PrivateNetworkError, privateNetworkErrorSchema } from '../../../shared/privateNetwork/pairing'
import { PRODUCT_PROTOCOL_VERSION } from '../../../shared/productProtocol/identity'
import { PRODUCT_LIMITS } from '../../../shared/productProtocol/limits'
import { isPrivateNetworkAddress } from './PrivateNetworkTlsIdentity'

interface ConnectionTransport {
  send: (frame: string) => boolean
  close: () => void
}
export interface PrivateNetworkServerOptions {
  auth: DeviceAuthorizationService
  identity: { serviceId: string, profileId: string }
  tls: PrivateNetworkTlsIdentity
  connect: (identity: AuthenticatedDevice, transport: ConnectionTransport) => ProductConnection
  bytes?: (request: IncomingMessage, response: ServerResponse, identity: AuthenticatedDevice) => Promise<boolean>
}

export class PrivateNetworkServer {
  readonly #options: PrivateNetworkServerOptions
  readonly #server: Server
  readonly #websocket = new WebSocketServer({ noServer: true, maxPayload: PRODUCT_LIMITS.frameBytes, perMessageDeflate: false, clientTracking: false })
  readonly #connections = new Map<WebSocket, { identity: AuthenticatedDevice, product: ProductConnection }>()
  readonly #requests = new Map<ServerResponse, string>()
  readonly #sockets = new Set<Socket>()
  readonly #rates = new Map<string, { start: number, requests: number, pairing: number }>()
  readonly #unsubscribe: { dispose: () => void }
  readonly #expiration: ReturnType<typeof setInterval>
  #inFlight = 0
  #closed = false

  constructor(options: PrivateNetworkServerOptions) {
    this.#options = options
    this.#server = createServer({ key: options.tls.privateKey, cert: options.tls.certificate, minVersion: 'TLSv1.2', maxHeaderSize: limits.requestBytes, requestTimeout: limits.requestTimeoutMs, headersTimeout: limits.requestTimeoutMs, keepAliveTimeout: 5000 }, (request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Content-Security-Policy', 'default-src \'none\'; sandbox')
      void this.#handle(request, response).catch(error => this.#failure(response, error))
    })
    this.#server.maxConnections = limits.httpRequests + limits.connections
    this.#server.on('connection', (socket) => {
      this.#sockets.add(socket)
      socket.once('close', () => this.#sockets.delete(socket))
    })
    this.#server.on('upgrade', (request, socket, head) => {
      try {
        this.#rate(request, false)
        if (this.#closed || request.url !== '/v1/rpc' || request.method !== 'GET')
          throw new PrivateNetworkError('INVALID_REQUEST')
        const identity = options.auth.authenticate(bearer(request))
        if (this.#connections.size >= limits.connections || [...this.#connections.values()].filter(item => item.identity.deviceId === identity.deviceId).length >= limits.connectionsPerDevice)
          throw new PrivateNetworkError('LIMIT_EXCEEDED')
        this.#websocket.handleUpgrade(request, socket, head, websocket => this.#connected(websocket, identity))
      }
      catch {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      }
    })
    this.#unsubscribe = options.auth.onDidInvalidate(({ deviceId }) => {
      for (const [socket, connection] of this.#connections) {
        if (connection.identity.deviceId === deviceId)
          socket.terminate()
      }
      for (const [response, owner] of this.#requests) {
        if (owner === deviceId)
          response.destroy()
      }
    })
    this.#expiration = setInterval(() => {
      try {
        options.auth.sweep()
      }
      catch {
        for (const socket of this.#connections.keys()) socket.terminate()
        for (const response of this.#requests.keys()) response.destroy()
      }
    }, 1000)
    this.#expiration.unref()
  }

  async listen(address: string, port: number): Promise<string> {
    if (!isPrivateNetworkAddress(address) || !Number.isInteger(port) || port < 0 || port > 65535 || this.#closed)
      throw new PrivateNetworkError('INVALID_REQUEST')
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(port, address, () => {
        this.#server.off('error', reject)
        resolve()
      })
    })
    const actual = this.#server.address()
    if (!actual || typeof actual === 'string')
      throw new PrivateNetworkError('INVALID_REQUEST')
    return `https://${actual.family === 'IPv6' ? `[${actual.address}]` : actual.address}:${actual.port}`
  }

  async close(): Promise<void> {
    if (this.#closed)
      return
    this.#closed = true
    clearInterval(this.#expiration)
    this.#unsubscribe.dispose()
    for (const [socket, connection] of this.#connections) {
      connection.product.close()
      socket.terminate()
    }
    for (const response of this.#requests.keys()) response.destroy()
    this.#websocket.close()
    const finished = new Promise<void>(resolve => this.#server.close(() => resolve()))
    for (const socket of this.#sockets) socket.destroy()
    await finished
  }

  #connected(socket: WebSocket, identity: AuthenticatedDevice) {
    try {
      this.#options.auth.assertCurrent(identity)
      const product = this.#options.connect(identity, {
        send: (frame) => {
          try {
            this.#options.auth.assertCurrent(identity)
          }
          catch {
            socket.terminate()
            return false
          }
          if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount + Buffer.byteLength(frame) > PRODUCT_LIMITS.connectionBytes) {
            socket.terminate()
            return false
          }
          socket.send(frame, (error) => {
            if (error)
              socket.terminate()
          })
          return true
        },
        close: () => socket.terminate(),
      })
      this.#connections.set(socket, { identity, product })
      socket.on('message', (data, binary) => {
        if (binary) {
          socket.terminate()
          return
        }
        void product.receive(data.toString()).catch(() => socket.terminate())
      })
      socket.on('error', () => socket.terminate())
      socket.once('close', () => {
        product.close()
        this.#connections.delete(socket)
      })
    }
    catch { socket.terminate() }
  }

  async #handle(request: IncomingMessage, response: ServerResponse) {
    if (this.#closed || this.#inFlight >= limits.httpRequests)
      throw new PrivateNetworkError('LIMIT_EXCEEDED')
    this.#inFlight++
    try {
      const route = request.url ?? ''
      this.#rate(request, route.startsWith('/v1/pairing/'))
      if (route.includes('?') || route.includes('#'))
        throw new PrivateNetworkError('INVALID_REQUEST')
      if (route === '/v1/connection-info' && (request.method === 'GET' || request.method === 'HEAD')) {
        this.#json(response, { ...this.#options.identity, protocol: PRODUCT_PROTOCOL_VERSION, pairingVersion: 1 }, request.method === 'HEAD')
        return
      }
      if (route.startsWith('/v1/pairing/')) {
        if (request.method !== 'POST')
          throw new PrivateNetworkError('INVALID_REQUEST')
        const input = await readJson(request)
        let result: unknown
        switch (route) {
          case '/v1/pairing/prepare':
            result = this.#options.auth.prepare(input)
            break
          case '/v1/pairing/redeem':
            result = this.#options.auth.redeem(input)
            break
          case '/v1/pairing/recover':
            result = this.#options.auth.recover(input)
            break
          case '/v1/pairing/confirm':
            pairingConfirmSchema.parse(input)
            result = this.#options.auth.confirm(bearer(request))
            break
          default: throw new PrivateNetworkError('INVALID_REQUEST')
        }
        this.#json(response, result)
        return
      }
      const token = bearer(request)
      const identity = this.#options.auth.authenticate(token)
      this.#requests.set(response, identity.deviceId)
      if (route === '/v1/device' && request.method === 'GET') {
        this.#json(response, this.#options.auth.state(token))
      }
      else if (['/v1/device/renew', '/v1/device/logout'].includes(route) && request.method === 'POST') {
        pairingConfirmSchema.parse(await readJson(request))
        if (route.endsWith('/renew')) {
          this.#json(response, this.#options.auth.renew(token))
        }
        else {
          this.#requests.delete(response)
          this.#options.auth.revoke(identity.deviceId)
          this.#json(response, { revoked: true })
        }
      }
      else if (!await this.#options.bytes?.(request, response, identity)) {
        throw new PrivateNetworkError('INVALID_REQUEST')
      }
    }
    finally {
      this.#requests.delete(response)
      this.#inFlight--
    }
  }

  #rate(request: IncomingMessage, pairing: boolean) {
    const key = request.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    for (const [address, entry] of this.#rates) {
      if (now - entry.start >= 60_000)
        this.#rates.delete(address)
    }
    let entry = this.#rates.get(key)
    if (!entry) {
      if (this.#rates.size >= 256)
        throw new PrivateNetworkError('LIMIT_EXCEEDED')
      entry = { start: now, requests: 0, pairing: 0 }
      this.#rates.set(key, entry)
    }
    entry.requests++
    if (pairing)
      entry.pairing++
    if (entry.requests > limits.requestsPerMinute || entry.pairing > limits.pairingRequestsPerMinute)
      throw new PrivateNetworkError('LIMIT_EXCEEDED')
  }

  #json(response: ServerResponse, value: unknown, head = false) {
    if (response.destroyed)
      return
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(head ? undefined : JSON.stringify(value))
  }

  #failure(response: ServerResponse, error: unknown) {
    if (response.destroyed)
      return
    if (response.headersSent) {
      response.destroy()
      return
    }
    const safe = privateNetworkErrorSchema.shape.error.safeParse(error && typeof error === 'object' && 'code' in error ? error.code : undefined)
    const code = safe.success ? safe.data : error instanceof z.ZodError ? 'INVALID_REQUEST' : 'STORAGE_UNAVAILABLE'
    response.statusCode = code === 'NOT_AUTHORIZED' ? 401 : code === 'LIMIT_EXCEEDED' ? 429 : code === 'STORAGE_UNAVAILABLE' ? 503 : code === 'VERSION_CHANGED' ? 412 : code === 'RANGE_INVALID' ? 416 : code === 'UPLOAD_CONFLICT' ? 409 : code === 'RESOURCE_UNAVAILABLE' ? 404 : 400
    this.#json(response, { error: code })
  }
}

function bearer(request: IncomingMessage): string {
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string' || !/^Bearer [\w.-]{1,256}$/.test(authorization))
    throw new PrivateNetworkError('NOT_AUTHORIZED')
  return authorization.slice(7)
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json' || Number(request.headers['content-length'] ?? 0) > limits.requestBytes)
    throw new PrivateNetworkError('INVALID_REQUEST')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    bytes += chunk.byteLength
    if (bytes > limits.requestBytes)
      throw new PrivateNetworkError('LIMIT_EXCEEDED')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  catch { throw new PrivateNetworkError('INVALID_REQUEST') }
}
