import type { RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import type { WebHostChange } from '../WebHostClient'
import { describe, expect, it, vi } from 'vitest'
import { WebHostClient } from '../WebHostClient'

function fixture() {
  const listeners = new Set<(method: string, params: unknown) => void>()
  const peer: Pick<RuntimeRpcPeerContract, 'request' | 'notify' | 'onNotification'> = {
    request: vi.fn(async () => ({ ok: true, status: 200, headers: {}, url: 'https://example.com/private' })),
    notify: vi.fn(),
    onNotification: (listener) => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
  }
  const client = new WebHostClient(peer)
  const facts: WebHostChange[] = []
  client.onDidChange(change => facts.push(change))
  const chunk = (params: object) => listeners.forEach(listener => listener('host.web.chunk', params))
  return { client, peer, facts, chunk, listeners }
}

describe('web host transport facts', () => {
  it('keeps a received head distinct from the completed body and closes the subscription', async () => {
    const { client, facts, chunk, listeners } = fixture()
    const response = await client.providerFetch('https://example.com/private', { method: 'POST', headers: {}, body: 'private-body', signal: new AbortController().signal })
    const requestId = facts[0]!.requestId
    expect(client.snapshot.active).toHaveLength(1)
    chunk({ requestId, chunk: 'b2s=' })
    chunk({ requestId, done: true })
    expect(await response.text()).toBe('ok')
    expect(facts.at(-1)).toMatchObject({ phase: 'settled', outcome: 'received', count: 2 })
    expect(client.snapshot.active).toEqual([])
    expect(listeners.size).toBe(0)
    expect(JSON.stringify(facts)).not.toMatch(/private|https/)
    await client.dispose()
  })

  it('waits for a valid head when the final body chunk arrives first', async () => {
    const { client, facts, peer, chunk } = fixture()
    const head = Promise.withResolvers<unknown>()
    peer.request = () => head.promise
    const fetching = client.providerFetch('https://example.com', { method: 'POST', headers: {}, body: '', signal: new AbortController().signal })
    const requestId = facts[0]!.requestId
    chunk({ requestId, chunk: 'b2s=' })
    chunk({ requestId, done: true })
    expect(facts.map(change => change.phase)).toEqual(['requested'])
    head.resolve({ ok: true, status: 200, headers: {}, url: 'https://example.com' })
    expect(await (await fetching).text()).toBe('ok')
    expect(facts.map(change => change.phase)).toEqual(['requested', 'head-received', 'settled'])
    await client.dispose()
  })

  it('settles an unread response as unknown on shutdown and does not invent host cancellation confirmation', async () => {
    const { client, facts, peer, listeners } = fixture()
    const response = await client.providerFetch('https://example.com', { method: 'POST', headers: {}, body: 'private-body', signal: new AbortController().signal })
    await client.dispose()
    await expect(response.text()).rejects.toThrow()
    expect(facts.slice(-2)).toMatchObject([{ phase: 'cancel-requested' }, { phase: 'settled', outcome: 'unknown', cancelled: true }])
    expect(peer.notify).toHaveBeenCalledWith('host.web.cancel', { requestId: facts[0]!.requestId })
    expect(client.snapshot.active).toEqual([])
    expect(listeners.size).toBe(0)
    await expect(client.authorize('https://example.com')).rejects.toThrow()
  })

  it('retains unknown outcome when cancellation delivery itself fails', async () => {
    const { client, facts, peer } = fixture()
    peer.notify = () => {
      throw new Error('private-peer-data')
    }
    await client.providerFetch('https://example.com', { method: 'POST', headers: {}, body: '', signal: new AbortController().signal })
    await client.dispose()
    expect(facts.slice(-3)).toMatchObject([{ phase: 'cancel-requested' }, { phase: 'cancel-unconfirmed' }, { phase: 'settled', outcome: 'unknown' }])
    expect(JSON.stringify(facts)).not.toContain('private-peer-data')
  })
})
