import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PRODUCT_LIMITS } from '../../../../shared/productProtocol/limits'
import { ProductSyncPublisher } from '../ProductSyncPublisher'

function fixture(topics = 1) {
  const publisher = new ProductSyncPublisher()
  let state = 0
  for (let index = 0; index < topics; index++)
    publisher.register(`topic-${index}`, { item: z.number(), change: z.union([z.number(), z.string()]), readSnapshot: () => ({ items: [state], complete: true, nextCursor: null }) })
  const frames: any[] = []
  let closed = false
  publisher.connect('connection', { send: (frame) => {
    frames.push(JSON.parse(frame))
    return true
  }, close: () => {
    closed = true
  } })
  return { publisher, frames, setState: (value: number) => {
    state = value
  }, closed: () => closed }
}

describe('productSyncPublisher', () => {
  it('buffers committed changes until the exact snapshot response has been queued', () => {
    const { publisher, frames, setState } = fixture()
    const { snapshot, activate } = publisher.subscribe('connection', { subscriptionId: 'sub', topic: 'topic-0' })
    setState(1)
    publisher.publishCommitted('topic-0', () => [1])
    setState(2)
    publisher.publishCommitted('topic-0', () => [2])
    expect(frames).toEqual([])
    expect(snapshot).toMatchObject({ mode: 'snapshot', items: [0], cursor: { seq: '0' } })
    activate()
    expect(frames.map(frame => [frame.params.fromSeq, frame.params.toSeq])).toEqual([['0', '1'], ['1', '2']])
    publisher.ack('connection', { subscriptionId: 'sub', syncEpoch: snapshot.cursor.syncEpoch, seq: '2' })
    expect(() => publisher.ack('connection', { subscriptionId: 'sub', syncEpoch: snapshot.cursor.syncEpoch, seq: '3' })).toThrow('SYNC_INVALID')
  })

  it('resumes only retained continuous epochs and bounds slow subscriptions', () => {
    const { publisher, frames } = fixture()
    const initial = publisher.subscribe('connection', { subscriptionId: 'sub', topic: 'topic-0' })
    initial.activate()
    for (let index = 0; index <= PRODUCT_LIMITS.subscriptionItems; index++)
      publisher.publishCommitted('topic-0', () => [index])
    expect(frames.at(-1)?.method).toBe('sync.resyncRequired')
    const resumed = publisher.subscribe('connection', { subscriptionId: 'fresh', topic: 'topic-0', base: { syncEpoch: initial.snapshot.cursor.syncEpoch, seq: '256' } })
    expect(resumed.snapshot.mode).toBe('resume')
    resumed.activate()
    expect(frames.at(-1)?.params.toSeq).toBe('257')
    publisher.unsubscribe('connection', 'fresh')
    for (let index = 0; index < PRODUCT_LIMITS.topicItems; index++)
      publisher.publishCommitted('topic-0', () => [index])
    const expired = publisher.subscribe('connection', { subscriptionId: 'expired', topic: 'topic-0', base: initial.snapshot.cursor })
    expect(expired.snapshot.mode).toBe('snapshot')
  })

  it('rebuilds a fresh snapshot when projection failure races an in-flight acknowledgement', () => {
    const { publisher, frames, setState } = fixture()
    const initial = publisher.subscribe('connection', { subscriptionId: 'sub', topic: 'topic-0' })
    initial.activate()
    publisher.publishCommitted('topic-0', () => [1])
    expect(frames.at(-1)?.params.toSeq).toBe('1')
    setState(2)
    publisher.publishCommitted('topic-0', () => {
      throw new Error('projection failed')
    })
    expect(frames.at(-1)?.method).toBe('sync.resyncRequired')
    expect(() => publisher.ack('connection', { subscriptionId: 'sub', syncEpoch: initial.snapshot.cursor.syncEpoch, seq: '1' })).toThrow('RESYNC_REQUIRED')
    const fresh = publisher.subscribe('connection', { subscriptionId: 'fresh', topic: 'topic-0' })
    fresh.activate()
    expect(fresh.snapshot).toMatchObject({ mode: 'snapshot', items: [2] })
    publisher.ack('connection', { subscriptionId: 'fresh', ...fresh.snapshot.cursor })
    expect(() => publisher.ack('connection', { subscriptionId: 'fresh', ...initial.snapshot.cursor })).toThrow('SYNC_INVALID')
  })

  it('closes only the over-budget connection while commits continue', () => {
    const { publisher, closed } = fixture(6)
    const healthy: any[] = []
    publisher.connect('healthy', { send: (frame) => {
      healthy.push(JSON.parse(frame))
      return true
    }, close: () => {
      throw new Error('Healthy client must remain')
    } })
    const healthySub = publisher.subscribe('healthy', { subscriptionId: 'healthy-sub', topic: 'topic-0' })
    healthySub.activate()
    for (let index = 0; index < 6; index++) {
      const sub = publisher.subscribe('connection', { subscriptionId: `sub-${index}`, topic: `topic-${index}` })
      sub.activate()
    }
    for (let index = 0; index < 6; index++)
      publisher.publishCommitted(`topic-${index}`, () => ['x'.repeat(800_000)])
    expect(closed()).toBe(true)
    publisher.ack('healthy', { subscriptionId: 'healthy-sub', syncEpoch: healthySub.snapshot.cursor.syncEpoch, seq: '1' })
    publisher.publishCommitted('topic-0', () => [7])
    expect(healthy.at(-1)?.params.changes).toEqual([7])
  })
})
