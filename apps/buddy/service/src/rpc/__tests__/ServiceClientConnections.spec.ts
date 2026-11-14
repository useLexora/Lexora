import { describe, expect, it } from 'vitest'
import { StorageIsolation } from '../../storage/StorageIsolation'
import { ServiceClientConnections } from '../ServiceClientConnections'
import { createServiceConnection } from './serviceConnectionHarness'

describe('serviceClientConnections', () => {
  it('rejects late success and new clients after shared storage isolation', async () => {
    const storage = new StorageIsolation()
    const connections = new ServiceClientConnections(storage.assertAvailable)
    const subscription = storage.onDidIsolate(() => connections.stopAccepting())
    const first = createServiceConnection()
    const second = createServiceConnection()
    const entered = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<void>()
    connections.connect('product', first.server, rpc => rpc.onRequest('accept', async () => {
      entered.resolve()
      await completed.promise
      return { accepted: true }
    }))
    const pending = expect(first.client.request('accept', {})).rejects.toMatchObject({ code: -32000 })
    try {
      await entered.promise
      storage.isolate(new Error('Commit acknowledgement lost'))
      completed.resolve()
      await pending
      expect(first.received.some(message => 'result' in message)).toBe(false)
      expect(() => connections.connect('management', second.server, () => {})).toThrow('Storage is isolated')
      await expect(first.client.request('accept', {})).rejects.toMatchObject({ code: -32601 })
    }
    finally {
      completed.resolve()
      subscription.dispose()
      connections.dispose()
      first.close()
      second.close()
    }
  })

  it('releases connection waits and subscriptions while leaving the other client usable', async () => {
    const connections = new ServiceClientConnections()
    const first = createServiceConnection()
    const second = createServiceConnection()
    const waiting = Promise.withResolvers<void>()
    let waitSignal: AbortSignal | undefined
    connections.connect('product', first.server, rpc => rpc.onRequest('wait', async (_, signal) => {
      waitSignal = signal
      waiting.resolve()
      await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
    }))
    connections.connect('product', second.server, rpc => rpc.onRequest('read', () => ({ value: 'available' })))
    const pending = first.client.request('wait', {})
    const cancelled = expect(pending).rejects.toThrow('Connection closed')
    await waiting.promise
    first.close()
    await cancelled
    expect(waitSignal?.aborted).toBe(true)
    connections.notify('product', 'changed', { revision: 1 })
    await expect(second.client.request('read', {})).resolves.toEqual({ value: 'available' })
    expect(first.received).toEqual([])
    expect(second.received).toContainEqual({ jsonrpc: '2.0', method: 'changed', params: { revision: 1 } })
    connections.dispose()
    second.close()
  })

  it('keeps management challenges private and rolls back partial connection registration', async () => {
    const connections = new ServiceClientConnections()
    const product = createServiceConnection()
    const management = createServiceConnection()
    connections.connect('product', product.server, rpc => rpc.onRequest('read', () => ({ ok: true })))
    connections.connect('management', management.server, () => {})
    expect(() => connections.connect('management', product.server, (rpc) => {
      rpc.onRequest('admin.write', () => ({ ok: true }))
      rpc.onRequest('read', () => ({}))
    })).toThrow('already registered')
    await expect(product.client.request('admin.write', {})).rejects.toMatchObject({ code: -32601 })
    connections.notify('management', 'providers.authChallenge', { id: 'synthetic' })
    await expect(product.client.request('read', {})).resolves.toEqual({ ok: true })
    expect(product.received.some(message => 'method' in message && message.method === 'providers.authChallenge')).toBe(false)
    expect(management.received).toEqual([{ jsonrpc: '2.0', method: 'providers.authChallenge', params: { id: 'synthetic' } }])
    connections.dispose()
    product.close()
    management.close()
  })
})
