import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ProductConnection } from '../../../../service/src/productProtocol/ProductConnection'
import { ProductSyncPublisher } from '../../../../service/src/productProtocol/ProductSyncPublisher'
import { ProductRpcClient } from '../ProductRpcClient'
import { ProductSyncClient } from '../ProductSyncClient'

const cursor = { syncEpoch: 'epoch', seq: '0' }

it('commits every snapshot page before applying the following delta and acknowledging it', async () => {
  const publisher = new ProductSyncPublisher()
  let reads = 0
  let closed = false
  const schema = z.number()
  publisher.register('index', { item: schema, change: schema, readSnapshot: () => ({ items: [], complete: true, nextCursor: null }), openSnapshot: () => ({ read: () => ++reads === 1 ? { items: [1], complete: false, nextCursor: 'more' } : { items: [2], complete: true, nextCursor: null }, close: () => {
    closed = true
  } }) })
  let receive = (_frame: string) => {}
  const context = { serviceId: 'service', profileId: 'profile', dataGeneration: 'data', serviceInstanceId: 'instance', connectionId: 'connection', clientSessionId: 'session', deviceId: 'desktop', ownerPrincipalId: 'desktop-local', credentialId: 'local', grantGeneration: '1', role: 'owner' as const }
  const connection = new ProductConnection({ context, assertCurrent() {}, phase: () => 'ready', handlers: {}, sync: publisher, authorizeTopic() {}, send(frame) {
    receive(frame)
    return true
  }, close() {} })
  const client = new ProductRpcClient({ send: frame => connection.receive(frame), subscribe(listener) {
    receive = listener
    return () => {}
  }, close() {} })
  const sync = new ProductSyncClient(client)
  const events: string[] = []
  try {
    await client.initialize({ protocol: { major: 1, minMinor: 0, maxMinor: 0 }, client: { kind: 'desktop', version: 'test' }, supportedContentKinds: [], supportedReviewKinds: [] })
    const handle = sync.subscribe('index', {
      item: schema,
      change: schema,
      beginSnapshot: () => { events.push('begin') },
      appendSnapshot(items) {
        events.push(`page:${items.join(',')}`)
        if (items[0] === 1)
          publisher.publishCommitted('index', () => [3])
      },
      commitSnapshot: () => { events.push('commit') },
      applyChanges: (changes) => { events.push(`delta:${changes.join(',')}`) },
      invalidate: () => { events.push('invalid') },
    })
    await handle.ready
    expect(events).toEqual(['begin', 'page:1', 'page:2', 'commit', 'delta:3'])
    expect(closed).toBe(true)
    expect(publisher.inspect().connections[0]?.bytes).toBe(0)
  }
  finally {
    sync.close()
    client.close()
    connection.close()
  }
})

describe('ordered client synchronization', () => {
  it('ignores duplicates, rejects gaps and does not consume a removed subscription', async () => {
    let listener = (_notification: { method: string, params: unknown }) => {}
    let id = ''
    const acknowledgements: unknown[] = []
    const applied: unknown[] = []
    const invalidations: unknown[] = []
    const sync = new ProductSyncClient({
      onNotification(value) {
        listener = value
        return () => {}
      },
      async request(method, params) {
        if (method === 'sync.subscribe') {
          id = (params as { subscriptionId: string }).subscriptionId
          return { subscriptionId: id, mode: 'snapshot', cursor, items: [], complete: true, nextCursor: null }
        }
        if (method === 'sync.ack')
          acknowledgements.push(params)
        return {}
      },
    })
    const handle = sync.subscribe('index', { item: z.number(), change: z.number(), beginSnapshot() {}, appendSnapshot() {}, commitSnapshot() {}, applyChanges: (changes) => {
      applied.push(changes)
    }, invalidate: (error) => {
      invalidations.push(error)
    } })
    await handle.ready
    const emit = (fromSeq: string, toSeq: string) => listener({ method: 'sync.delta', params: { subscriptionId: id, syncEpoch: 'epoch', fromSeq, toSeq, changes: [1] } })
    emit('0', '1')
    await expect.poll(() => acknowledgements.length).toBe(1)
    emit('0', '1')
    await expect.poll(() => acknowledgements.length).toBe(2)
    expect(applied).toEqual([[1]])
    emit('2', '3')
    await expect.poll(() => invalidations.length).toBe(1)
    emit('1', '2')
    expect(applied).toEqual([[1]])
    expect(acknowledgements).toHaveLength(2)
    sync.close()
  })
})
