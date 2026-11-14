import type { ZodType } from 'zod'
import type { ProductSyncCursor, ProductSyncDelta } from '../../../shared/productProtocol/sync'
import type { ProductRpcClient } from './ProductRpcClient'
import { randomUUID } from 'node:crypto'
import { PRODUCT_LIMITS, productByteLength } from '../../../shared/productProtocol/limits'
import { classifyProductDelta, productResyncRequiredSchema, productSyncDeltaSchema, productSyncSnapshotSchema } from '../../../shared/productProtocol/sync'

export interface ProductTopicConsumer<Item, Change> {
  item: ZodType<Item>
  change: ZodType<Change>
  beginSnapshot: () => void | Promise<void>
  appendSnapshot: (items: Item[]) => void | Promise<void>
  commitSnapshot: (cursor: ProductSyncCursor) => void | Promise<void>
  applyChanges: (changes: Change[], cursor: ProductSyncCursor) => void | Promise<void>
  invalidate: (error: unknown) => void
}
interface Subscription {
  id: string
  cursor: ProductSyncCursor | null
  queue: Array<{ delta: ProductSyncDelta, bytes: number }>
  bytes: number
  items: number
  ready: boolean
  active: boolean
  processing: boolean
  consumer: ProductTopicConsumer<unknown, unknown>
}

export class ProductSyncClient {
  readonly #client: Pick<ProductRpcClient, 'request' | 'onNotification'>
  readonly #stop: () => void
  readonly #subscriptions = new Map<string, Subscription>()
  #bytes = 0
  #closed = false

  constructor(client: Pick<ProductRpcClient, 'request' | 'onNotification'>) {
    this.#client = client
    this.#stop = client.onNotification(notification => this.#receive(notification))
  }

  subscribe<Item, Change>(topic: string, consumer: ProductTopicConsumer<Item, Change>) {
    if (this.#closed || this.#subscriptions.size >= PRODUCT_LIMITS.subscriptionsPerConnection)
      throw new Error('PRODUCT_SUBSCRIPTION_LIMIT')
    const subscription: Subscription = { id: randomUUID(), cursor: null, queue: [], bytes: 0, items: 0, ready: false, active: true, processing: false, consumer: consumer as ProductTopicConsumer<unknown, unknown> }
    this.#subscriptions.set(subscription.id, subscription)
    const ready = this.#snapshot(subscription, topic).catch((error) => {
      this.#invalidate(subscription, error)
      throw error
    })
    return { ready, dispose: () => this.#remove(subscription) }
  }

  close(): void {
    if (this.#closed)
      return
    this.#closed = true
    this.#stop()
    for (const subscription of [...this.#subscriptions.values()])
      this.#remove(subscription)
  }

  async #snapshot(subscription: Subscription, topic: string): Promise<void> {
    let page = productSyncSnapshotSchema.parse(await this.#client.request('sync.subscribe', { subscriptionId: subscription.id, topic }))
    if (!subscription.active)
      return
    if (page.mode !== 'snapshot' || page.subscriptionId !== subscription.id)
      throw new Error('SYNC_INVALID')
    const cursor = page.cursor
    await subscription.consumer.beginSnapshot()
    const cursors = new Set<string>()
    while (subscription.active) {
      if (page.mode !== 'snapshot' || page.subscriptionId !== subscription.id || page.cursor.syncEpoch !== cursor.syncEpoch || page.cursor.seq !== cursor.seq)
        throw new Error('SYNC_INVALID')
      const bytes = productByteLength(JSON.stringify(page))
      if (bytes > PRODUCT_LIMITS.pageBytes || this.#bytes + bytes > PRODUCT_LIMITS.connectionBytes)
        throw new Error('RESYNC_REQUIRED')
      this.#bytes += bytes
      try {
        const items = page.items.map(item => subscription.consumer.item.parse(item))
        await subscription.consumer.appendSnapshot(items)
      }
      finally { this.#bytes -= bytes }
      if (!subscription.active)
        return
      if (page.complete)
        break
      if (!page.nextCursor || cursors.has(page.nextCursor))
        throw new Error('SYNC_INVALID')
      cursors.add(page.nextCursor)
      page = productSyncSnapshotSchema.parse(await this.#client.request('sync.snapshotPage', { subscriptionId: subscription.id, cursor: page.nextCursor }))
    }
    if (!subscription.active)
      return
    await subscription.consumer.commitSnapshot(cursor)
    if (!subscription.active)
      return
    subscription.cursor = cursor
    subscription.ready = true
    await this.#pump(subscription)
  }

  #receive(notification: { method: string, params: unknown }): void {
    try {
      if (notification.method === 'sync.resyncRequired') {
        const request = productResyncRequiredSchema.parse(notification.params)
        const subscription = this.#subscriptions.get(request.subscriptionId)
        if (subscription)
          this.#invalidate(subscription, new Error('RESYNC_REQUIRED'))
        return
      }
      if (notification.method !== 'sync.delta')
        return
      const delta = productSyncDeltaSchema.parse(notification.params)
      const subscription = this.#subscriptions.get(delta.subscriptionId)
      if (!subscription?.active)
        return
      const bytes = productByteLength(JSON.stringify(delta))
      if (subscription.bytes + bytes > PRODUCT_LIMITS.subscriptionBytes || subscription.items + delta.changes.length > PRODUCT_LIMITS.subscriptionItems || this.#bytes + bytes > PRODUCT_LIMITS.connectionBytes) {
        this.#invalidate(subscription, new Error('RESYNC_REQUIRED'))
        return
      }
      subscription.queue.push({ delta, bytes })
      subscription.items += delta.changes.length
      subscription.bytes += bytes
      this.#bytes += bytes
      void this.#pump(subscription).catch(error => this.#invalidate(subscription, error))
    }
    catch (error) {
      for (const subscription of [...this.#subscriptions.values()])
        this.#invalidate(subscription, error)
    }
  }

  async #pump(subscription: Subscription): Promise<void> {
    if (!subscription.active || !subscription.ready || subscription.processing)
      return
    subscription.processing = true
    try {
      while (subscription.active && subscription.queue.length) {
        const { delta, bytes } = subscription.queue[0]!
        const classification = classifyProductDelta(subscription.cursor!, delta)
        if (classification === 'resync')
          throw new Error('RESYNC_REQUIRED')
        if (classification === 'apply') {
          const cursor = { syncEpoch: delta.syncEpoch, seq: delta.toSeq }
          await subscription.consumer.applyChanges(delta.changes.map(change => subscription.consumer.change.parse(change)), cursor)
          if (!subscription.active)
            return
          subscription.cursor = cursor
        }
        await this.#client.request('sync.ack', { subscriptionId: subscription.id, ...subscription.cursor })
        if (!subscription.active)
          return
        subscription.queue.shift()
        subscription.items -= delta.changes.length
        subscription.bytes -= bytes
        this.#bytes -= bytes
      }
    }
    finally { subscription.processing = false }
  }

  #invalidate(subscription: Subscription, error: unknown): void {
    if (!subscription.active)
      return
    this.#remove(subscription)
    subscription.consumer.invalidate(error)
  }

  #remove(subscription: Subscription): void {
    if (!subscription.active)
      return
    subscription.active = false
    this.#subscriptions.delete(subscription.id)
    this.#bytes -= subscription.bytes
    subscription.queue = []
    subscription.bytes = 0
    subscription.items = 0
    void this.#client.request('sync.unsubscribe', { subscriptionId: subscription.id }).catch(() => {})
  }
}
