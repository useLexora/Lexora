import type { Credential } from '@earendil-works/pi-ai'
import type { RuntimeRequestHandler, RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import { describe, expect, it } from 'vitest'

import { HostCredentialStore } from '../HostCredentialStore'

describe('hostCredentialStore', () => {
  it('drains an accepted read before closing observations and rejects fresh requests during stop', async () => {
    const peer = new CredentialHostPeer({})
    const pending = Promise.withResolvers<unknown>()
    peer.request = () => pending.promise
    const store = new HostCredentialStore(peer)
    const observed: string[] = []
    store.onDidChange(event => observed.push(event.kind))
    const read = store.read('fixture')
    const stopping = store.dispose()
    await expect(store.list()).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' })
    pending.resolve({ ok: true, value: null })
    await read
    await stopping
    expect(store.snapshot.providers).toMatchObject([{ providerId: 'fixture', presence: 'absent' }])
    expect(observed).toEqual(['observation'])
  })

  it('distinguishes unknown host state from absence and suppresses token-only changes', async () => {
    const peer = new CredentialHostPeer({ fixture: { type: 'oauth', access: 'fixture-a', refresh: 'fixture-r', expires: 0 } })
    const store = new HostCredentialStore(peer)
    const changes: import('../HostCredentialStore').CredentialChange[] = []
    store.onDidChange(event => changes.push(event))
    await store.list()
    const before = changes.filter(event => event.kind === 'observation').length
    await store.modify('fixture', async current => ({ ...current!, type: 'oauth', access: 'fixture-b', refresh: 'fixture-r', expires: 1 }))
    expect(changes.filter(event => event.kind === 'observation')).toHaveLength(before)
    expect(changes.at(-1)?.kind).toBe('write-confirmed')
    const request = peer.request.bind(peer)
    peer.request = async () => {
      throw new Error('fixture unavailable')
    }
    await expect(store.list()).rejects.toThrow('fixture unavailable')
    expect(store.snapshot.availability).toBe('unknown')
    expect(store.snapshot.providers).toMatchObject([{ presence: 'present' }])
    peer.request = request
    await store.delete('fixture')
    expect(store.snapshot.providers).toMatchObject([{ presence: 'absent', type: null }])
    expect(JSON.stringify(changes)).not.toContain('fixture-b')
    await store.dispose()
  })

  it('does not let an older read restore a deleted credential or an older list failure replace current health', async () => {
    const peer = new CredentialHostPeer({ fixture: { type: 'api_key', key: 'fixture-key' } })
    const store = new HostCredentialStore(peer)
    const request = peer.request.bind(peer)
    const oldRead = Promise.withResolvers<unknown>()
    peer.request = (method, params) => method === 'host.credentials.read' ? oldRead.promise : request(method, params)
    const reading = store.read('fixture')
    await store.delete('fixture')
    oldRead.resolve({ ok: true, value: { type: 'api_key', key: 'fixture-key' } })
    await reading
    expect(store.snapshot.providers).toMatchObject([{ presence: 'absent' }])
    const oldList = Promise.withResolvers<unknown>()
    peer.request = () => oldList.promise
    const listing = expect(store.list()).rejects.toThrow('fixture old list')
    peer.request = request
    await store.list()
    oldList.reject(new Error('fixture old list'))
    await listing
    expect(store.snapshot.availability).toBe('known')
    await store.dispose()
  })

  it('serializes concurrent OAuth refreshes for the same provider', async () => {
    const peer = new CredentialHostPeer({
      anthropic: {
        type: 'oauth',
        access: 'access-0',
        refresh: 'refresh-0',
        expires: 0,
        generation: 0,
      },
    })
    const store = new HostCredentialStore(peer)

    await Promise.all([
      store.modify('anthropic', async (current) => {
        await new Promise(resolve => setTimeout(resolve, 15))
        return nextOAuthCredential(current)
      }),
      store.modify('anthropic', async current => nextOAuthCredential(current)),
    ])

    await expect(store.read('anthropic')).resolves.toMatchObject({
      access: 'access-2',
      generation: 2,
      refresh: 'refresh-2',
    })
  })
})

function nextOAuthCredential(current: Credential | undefined): Credential {
  if (!current || current.type !== 'oauth')
    throw new Error('expected OAuth credential')

  const generation = Number(current.generation ?? 0) + 1
  return {
    ...current,
    access: `access-${generation}`,
    refresh: `refresh-${generation}`,
    generation,
  }
}

class CredentialHostPeer implements RuntimeRpcPeerContract {
  readonly #credentials = new Map<string, Credential>()
  writeCount = 0

  constructor(initial: Record<string, Credential>) {
    for (const [providerId, credential] of Object.entries(initial))
      this.#credentials.set(providerId, structuredClone(credential))
  }

  close(): void {}

  notify(): void {}

  onNotification(): () => void {
    return () => {}
  }

  onRequest(_method: string, _handler: RuntimeRequestHandler): () => void {
    return () => {}
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const input = params as { providerId: string, credential?: Credential }
    if (method === 'host.credentials.read') {
      return {
        ok: true,
        value: structuredClone(this.#credentials.get(input.providerId) ?? null),
      }
    }
    if (method === 'host.credentials.list') {
      return {
        ok: true,
        providers: [...this.#credentials].map(([providerId, credential]) => ({
          providerId,
          type: credential.type,
        })),
      }
    }
    if (method === 'host.credentials.write') {
      this.writeCount += 1
      this.#credentials.set(input.providerId, structuredClone(input.credential!))
      return { ok: true }
    }
    if (method === 'host.credentials.delete') {
      this.#credentials.delete(input.providerId)
      return { ok: true }
    }
    throw new Error(`unexpected method: ${method}`)
  }
}
