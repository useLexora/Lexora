import type { ProductClientTransport } from '../ProductRpcClient'
import { describe, expect, it } from 'vitest'
import { ProductConnection } from '../../../../service/src/productProtocol/ProductConnection'
import { ProductRpcClient } from '../ProductRpcClient'

const initialize = { protocol: { major: 1, minMinor: 1, maxMinor: 1 }, client: { kind: 'desktop' as const, version: '0.20.0' }, supportedContentKinds: ['buddy.user.v1'], supportedReviewKinds: [] }
const context = { serviceId: 'service', profileId: 'profile', dataGeneration: 'generation', serviceInstanceId: 'instance', connectionId: 'connection', clientSessionId: 'session', deviceId: 'desktop', ownerPrincipalId: 'desktop-local', credentialId: 'local', grantGeneration: '1', role: 'owner' as const }

function fixture() {
  let receive: (frame: string) => void = () => {}
  let disconnected = false
  const frames: string[] = []
  const server = new ProductConnection({ context, assertCurrent() {}, phase: () => 'ready', handlers: { 'commands.get': { handle: () => ({ lookup: 'not_found' }) } }, send(frame) {
    receive(frame)
    return true
  }, close() {} })
  const transport: ProductClientTransport = {
    send(frame) {
      frames.push(frame)
      return server.receive(frame)
    },
    subscribe(listener) {
      receive = listener
      return () => {
        receive = () => {}
      }
    },
    close() {
      disconnected = true
    },
  }
  const client = new ProductRpcClient(transport)
  return { client, server, frames, emit: (frame: string) => receive(frame), disconnected: () => disconnected }
}

describe('product JSON transport client', () => {
  it('negotiates with the real server connection and preserves the restricted error and query contracts', async () => {
    const { client, server } = fixture()
    try {
      await expect(client.request('commands.get', { dataGeneration: 'generation', commandId: 'command' })).rejects.toThrow('PRODUCT_NOT_INITIALIZED')
      const result = await client.initialize(initialize)
      expect(result).toMatchObject({ protocol: { major: 1, minor: 1 }, dataGeneration: 'generation', profileId: 'profile', capabilities: ['commands.get'] })
      expect(await client.request('commands.get', { dataGeneration: 'generation', commandId: 'command' })).toEqual({ lookup: 'not_found' })
      await expect(client.request('chat.cancel', { dataGeneration: 'generation', commandId: 'cancel', expectedServiceInstanceId: 'instance', intent: { runId: 'run', expectedRunGeneration: '1' } })).rejects.toMatchObject({ code: 'METHOD_NOT_AVAILABLE', acceptance: 'not_accepted' })
    }
    finally {
      client.close()
      server.close()
    }
  })

  it('preserves an incompatible handshake error and stops before any product request', async () => {
    const { client, server, frames, disconnected } = fixture()
    try {
      const legacy = { ...initialize, protocol: { major: 1, minMinor: 0, maxMinor: 0 } }
      await expect(client.initialize(legacy)).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE', acceptance: 'not_accepted', recovery: 'refresh' })
      expect(disconnected()).toBe(true)
      expect(() => client.identity).toThrow('PRODUCT_NOT_INITIALIZED')
      await expect(client.request('commands.get', { dataGeneration: 'generation', commandId: 'command' })).rejects.toThrow('PRODUCT_NOT_INITIALIZED')
      await expect(client.initialize(legacy)).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' })
      expect(frames.map(frame => JSON.parse(frame).method)).toEqual(['initialize'])
    }
    finally {
      client.close()
      server.close()
    }
  })

  it('closes only its transport on malformed frames and does not accept secret-bearing error extensions', async () => {
    const { client, server, emit, disconnected } = fixture()
    await client.initialize(initialize)
    emit(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: 'INTERNAL_ERROR', message: 'INTERNAL_ERROR', acceptance: 'unknown', recovery: 'query_command', path: '/private/profile' } }))
    expect(disconnected()).toBe(true)
    await expect(client.request('commands.get', { dataGeneration: 'generation', commandId: 'command' })).rejects.toThrow('PRODUCT_CONNECTION_CLOSED')
    server.close()
  })
})
