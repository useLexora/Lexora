import type { TrustedProductContext } from '../../../../shared/productProtocol/identity'
import { describe, expect, it } from 'vitest'
import { ProductConnection } from '../ProductConnection'

const context: TrustedProductContext = { serviceId: 'service', profileId: 'profile', dataGeneration: 'data', serviceInstanceId: 'instance', connectionId: 'connection', clientSessionId: 'session', deviceId: 'device', ownerPrincipalId: 'owner', credentialId: 'credential', grantGeneration: '1', role: 'owner' }
const initialize = { protocol: { major: 1, minMinor: 0, maxMinor: 0 }, client: { kind: 'desktop', version: '1' }, supportedContentKinds: ['buddy-user-content-v1'], supportedReviewKinds: [] }
const command = { dataGeneration: 'data', commandId: 'command', expectedServiceInstanceId: 'instance', intent: { draftId: 'draft', expectedRevision: '0' } }
const receipt = { dataGeneration: 'data', commandId: 'command', method: 'chat.startTurn', decision: 'accepted', decidedAt: '2026-01-01T00:00:00.000Z', target: { runId: 'run' }, result: {} }
function setup(options: { handle?: () => unknown | Promise<unknown> } = {}) {
  const frames: Record<string, any>[] = []
  const connection = new ProductConnection({
    context,
    assertCurrent() {},
    phase: () => 'ready',
    handlers: { 'chat.startTurn': { handle: options.handle ?? (() => ({ receipt })) }, 'commands.get': { handle: () => ({ lookup: 'pending' }) } },
    send: (raw) => {
      frames.push(JSON.parse(raw))
      return true
    },
    close() {},
  })
  const send = (method: string, params: unknown, id = 'request') => connection.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  return { frames, send }
}

describe('productConnection', () => {
  it('requires one compatible initialization without trusting claimed identity', async () => {
    const client = setup()
    await client.send('chat.startTurn', command)
    expect(client.frames.at(-1)?.error.code).toBe('NOT_INITIALIZED')
    await client.send('initialize', { ...initialize, ownerPrincipalId: 'forged' })
    expect(client.frames.at(-1)?.error.code).toBe('INVALID_PARAMS')
    await client.send('initialize', { ...initialize, protocol: { major: 2, minMinor: 0, maxMinor: 0 } })
    expect(client.frames.at(-1)?.error.code).toBe('PROTOCOL_INCOMPATIBLE')
    await client.send('initialize', initialize)
    expect(client.frames.at(-1)?.result.connectionId).toBe(context.connectionId)
    expect(JSON.stringify(client.frames.at(-1))).not.toContain('credential')
    await client.send('initialize', initialize)
    expect(client.frames.at(-1)?.error.code).toBe('ALREADY_INITIALIZED')
  })

  it('retains uncertain command outcome and hides internal causes', async () => {
    const client = setup({ handle: () => {
      throw new Error('SECRET /private/fixture token=do-not-emit')
    } })
    await client.send('initialize', initialize)
    await client.send('chat.startTurn', command)
    expect(client.frames.at(-1)?.error).toMatchObject({ code: 'INTERNAL_ERROR', acceptance: 'unknown', recovery: 'query_command' })
    expect(JSON.stringify(client.frames)).not.toContain('SECRET')
  })
})
