import type { ZodType } from 'zod'
import type { ProductSyncCursor, ProductSyncSnapshot } from '../../../shared/productProtocol/sync'
import { randomUUID } from 'node:crypto'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { encodeProductFrame, PRODUCT_LIMITS, productByteLength } from '../../../shared/productProtocol/limits'
import { encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { productAckSchema, productSnapshotPageSchema, productSubscribeSchema } from '../../../shared/productProtocol/sync'

type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue | undefined }
export interface ProductSnapshotPage {
  items: readonly JsonValue[]
  complete: boolean
  nextCursor: string | null
}
export interface ProductSnapshotReader {
  read: (cursor: string | null) => ProductSnapshotPage
  close: () => void
}
interface TopicDefinition {
  item: ZodType<JsonValue>
  change: ZodType<JsonValue>
  readSnapshot: () => ProductSnapshotPage
  openSnapshot?: () => ProductSnapshotReader
}
interface Change {
  from: bigint
  to: bigint
  changes: JsonValue[]
  bytes: number
  count: number
}
interface Topic {
  definition: TopicDefinition
  epoch: string
  seq: bigint
  retained: Change[]
  items: number
  bytes: number
  valid: boolean
  reading: boolean
}
interface Subscription {
  id: string
  topic: Topic
  pending: Change[]
  items: number
  bytes: number
  ack: bigint
  sent: bigint
  active: boolean
  cursor: ProductSyncCursor
  reader?: ProductSnapshotReader
  nextCursor: string | null
  timer?: ReturnType<typeof setTimeout>
  cachedPage?: { requestCursor: string | null, snapshot: ProductSyncSnapshot<JsonValue>, bytes: number }
}
export interface ProductSyncTransport {
  send: (frame: string) => boolean
  close: () => void
}
interface Connection {
  transport: ProductSyncTransport
  subscriptions: Map<string, Subscription>
  bytes: number
}

export class ProductSyncPublisher {
  readonly #topics = new Map<string, Topic>()
  readonly #connections = new Map<string, Connection>()

  register(topic: string, definition: TopicDefinition): () => void {
    if (this.#topics.has(topic))
      throw new Error('Topic already registered')
    this.#topics.set(topic, { definition, epoch: randomUUID(), seq: 0n, retained: [], items: 0, bytes: 0, valid: true, reading: false })
    return () => {
      this.invalidate(topic)
      this.#topics.delete(topic)
    }
  }

  hasTopic(name: string): boolean {
    return this.#topics.has(name)
  }

  subscriptionCount(name: string): number {
    const topic = this.#topics.get(name)
    let count = 0
    for (const connection of this.#connections.values()) {
      for (const subscription of connection.subscriptions.values()) {
        if (subscription.topic === topic)
          count++
      }
    }
    return count
  }

  connect(connectionId: string, transport: ProductSyncTransport): () => void {
    if (this.#connections.has(connectionId))
      throw new ProductProtocolError('SYNC_INVALID')
    this.#connections.set(connectionId, { transport, subscriptions: new Map(), bytes: 0 })
    return () => {
      const connection = this.#connections.get(connectionId)
      if (connection) {
        for (const subscription of connection.subscriptions.values()) this.#releaseSnapshot(connection, subscription)
        this.#connections.delete(connectionId)
      }
    }
  }

  subscribe(connectionId: string, input: unknown): { snapshot: ProductSyncSnapshot<JsonValue>, activate: () => void } {
    const request = productSubscribeSchema.parse(input)
    const connection = this.#requireConnection(connectionId)
    const topic = this.#topics.get(request.topic)
    if (!topic || connection.subscriptions.has(request.subscriptionId) || connection.subscriptions.size >= PRODUCT_LIMITS.subscriptionsPerConnection)
      throw new ProductProtocolError('SYNC_INVALID')
    const floor = topic.retained[0]?.from ?? topic.seq
    const base = request.base && BigInt(request.base.seq)
    const resume = topic.valid && request.base?.syncEpoch === topic.epoch && base !== undefined && base >= floor && base <= topic.seq
    const captured = resume ? base as bigint : topic.seq
    const cursor = { syncEpoch: topic.epoch, seq: encodeProductRevision(captured) }
    let snapshot: ProductSyncSnapshot<JsonValue>
    let reader: ProductSnapshotReader | undefined
    if (resume) {
      snapshot = { subscriptionId: request.subscriptionId, mode: 'resume', cursor }
    }
    else {
      if (topic.reading)
        throw new ProductProtocolError('SYNC_INVALID')
      topic.reading = true
      try {
        reader = topic.definition.openSnapshot?.()
        const value = reader ? reader.read(null) : topic.definition.readSnapshot()
        if (!value.complete && !reader)
          throw new ProductProtocolError('RESYNC_REQUIRED')
        if ('then' in value || value.items.length > PRODUCT_LIMITS.pageItems || value.complete !== (value.nextCursor === null))
          throw new ProductProtocolError('PAGE_TOO_LARGE')
        snapshot = { subscriptionId: request.subscriptionId, mode: 'snapshot', cursor, items: value.items.map(item => topic.definition.item.parse(item)), complete: value.complete, nextCursor: value.nextCursor }
        encodeProductFrame(snapshot, PRODUCT_LIMITS.pageBytes)
        topic.valid = true
      }
      catch (error) {
        reader?.close()
        this.invalidate(request.topic)
        throw error
      }
      finally {
        topic.reading = false
      }
    }
    const subscription: Subscription = { id: request.subscriptionId, topic, pending: [], items: 0, bytes: 0, ack: captured, sent: captured, active: false, cursor, reader, nextCursor: snapshot.mode === 'snapshot' ? snapshot.nextCursor : null }
    connection.subscriptions.set(subscription.id, subscription)
    if (snapshot.mode === 'snapshot') {
      if (snapshot.complete) {
        reader?.close()
        subscription.reader = undefined
      }
      else {
        try {
          this.#cacheSnapshot(connection, subscription, null, snapshot)
        }
        catch (error) {
          this.#resync(connection, subscription)
          throw error
        }
        subscription.timer = setTimeout(() => this.#resync(connection, subscription), PRODUCT_LIMITS.snapshotLifetimeMs)
        subscription.timer.unref()
      }
    }
    for (const change of topic.retained.filter(change => change.to > captured)) {
      if (!this.#enqueue(connection, subscription, change))
        throw new ProductProtocolError('RESYNC_REQUIRED')
    }
    return { snapshot, activate: () => {
      if (connection.subscriptions.get(subscription.id) !== subscription)
        return
      if (!subscription.reader) {
        subscription.active = true
        this.#flush(connection, subscription)
      }
    } }
  }

  snapshotPage(connectionId: string, input: unknown): { snapshot: ProductSyncSnapshot<JsonValue>, activate: () => void } {
    const request = productSnapshotPageSchema.parse(input)
    const connection = this.#requireConnection(connectionId)
    const subscription = connection.subscriptions.get(request.subscriptionId)
    if (!subscription)
      throw new ProductProtocolError('RESYNC_REQUIRED')
    const activate = () => {
      if (!subscription.reader && connection.subscriptions.get(subscription.id) === subscription) {
        subscription.active = true
        this.#flush(connection, subscription)
      }
    }
    if (subscription.cachedPage?.requestCursor === request.cursor)
      return { snapshot: subscription.cachedPage.snapshot, activate }
    if (!subscription.reader || subscription.nextCursor !== request.cursor)
      throw new ProductProtocolError('CURSOR_EXPIRED')
    try {
      const value = subscription.reader.read(request.cursor)
      if (value.items.length > PRODUCT_LIMITS.pageItems || value.complete !== (value.nextCursor === null))
        throw new ProductProtocolError('PAGE_TOO_LARGE')
      const snapshot: ProductSyncSnapshot<JsonValue> = { subscriptionId: subscription.id, mode: 'snapshot', cursor: subscription.cursor, ...value, items: value.items.map(item => subscription.topic.definition.item.parse(item)) }
      this.#cacheSnapshot(connection, subscription, request.cursor, snapshot)
      subscription.nextCursor = value.nextCursor
      if (value.complete) {
        subscription.reader.close()
        subscription.reader = undefined
        clearTimeout(subscription.timer)
      }
      return { snapshot, activate }
    }
    catch (error) {
      this.#resync(connection, subscription)
      throw error
    }
  }

  publishCommitted(topicName: string, project: () => readonly JsonValue[]): void {
    const topic = this.#topics.get(topicName)
    if (!topic)
      throw new ProductProtocolError('SYNC_INVALID')
    if (topic.reading) {
      this.invalidate(topicName)
      throw new ProductProtocolError('SYNC_INVALID')
    }
    if (!topic.valid)
      return
    try {
      const changes = project().map(change => topic.definition.change.parse(change))
      if (!changes.length)
        return
      const to = topic.seq + 1n
      const encoded = encodeProductFrame({ syncEpoch: topic.epoch, fromSeq: encodeProductRevision(topic.seq), toSeq: encodeProductRevision(to), changes }, PRODUCT_LIMITS.subscriptionBytes - 1024)
      const change: Change = { from: topic.seq, to, changes, count: changes.length, bytes: productByteLength(encoded) + 512 }
      topic.seq = to
      topic.retained.push(change)
      topic.bytes += change.bytes
      topic.items += change.count
      while (topic.items > PRODUCT_LIMITS.topicItems || topic.bytes > PRODUCT_LIMITS.topicBytes) {
        const dropped = topic.retained.shift()!
        topic.bytes -= dropped.bytes
        topic.items -= dropped.count
      }
      for (const connection of this.#connections.values()) {
        for (const subscription of connection.subscriptions.values()) {
          if (subscription.topic === topic && this.#enqueue(connection, subscription, change))
            this.#flush(connection, subscription)
        }
      }
    }
    catch {
      this.invalidate(topicName)
    }
  }

  ack(connectionId: string, input: unknown): void {
    const request = productAckSchema.parse(input)
    const connection = this.#requireConnection(connectionId)
    const subscription = connection.subscriptions.get(request.subscriptionId)
    const seq = BigInt(request.seq)
    if (!subscription)
      throw new ProductProtocolError('RESYNC_REQUIRED')
    if (!subscription.active || request.syncEpoch !== subscription.topic.epoch || seq > subscription.sent)
      throw new ProductProtocolError('SYNC_INVALID')
    this.#clearCachedPage(connection, subscription)
    if (seq <= subscription.ack)
      return
    subscription.ack = seq
    while (subscription.pending[0] && subscription.pending[0].to <= seq) {
      const change = subscription.pending.shift()!
      subscription.items -= change.count
      subscription.bytes -= change.bytes
      connection.bytes -= change.bytes
    }
  }

  unsubscribe(connectionId: string, subscriptionId: string): void {
    const connection = this.#requireConnection(connectionId)
    const subscription = connection.subscriptions.get(subscriptionId)
    if (subscription) {
      this.#releaseSnapshot(connection, subscription)
      connection.bytes -= subscription.bytes
      connection.subscriptions.delete(subscriptionId)
    }
  }

  invalidate(topicName: string): void {
    const topic = this.#topics.get(topicName)
    if (!topic)
      return
    topic.valid = false
    topic.epoch = randomUUID()
    topic.seq = 0n
    topic.retained = []
    topic.items = 0
    topic.bytes = 0
    for (const connection of this.#connections.values()) {
      for (const subscription of connection.subscriptions.values()) {
        if (subscription.topic === topic)
          this.#resync(connection, subscription)
      }
    }
  }

  inspect() {
    return {
      topics: [...this.#topics.values()].map(topic => ({ retainedItems: topic.items, bytes: topic.bytes, valid: topic.valid })),
      connections: [...this.#connections.values()].map(connection => ({ subscriptions: connection.subscriptions.size, bytes: connection.bytes })),
    }
  }

  #cacheSnapshot(connection: Connection, subscription: Subscription, requestCursor: string | null, snapshot: ProductSyncSnapshot<JsonValue>): void {
    const bytes = productByteLength(encodeProductFrame(snapshot, PRODUCT_LIMITS.pageBytes))
    this.#clearCachedPage(connection, subscription)
    if (connection.bytes + bytes > PRODUCT_LIMITS.connectionBytes)
      throw new ProductProtocolError('RESYNC_REQUIRED')
    subscription.cachedPage = { requestCursor, snapshot, bytes }
    connection.bytes += bytes
  }

  #clearCachedPage(connection: Connection, subscription: Subscription): void {
    if (subscription.cachedPage) {
      connection.bytes -= subscription.cachedPage.bytes
      subscription.cachedPage = undefined
    }
  }

  #releaseSnapshot(connection: Connection, subscription: Subscription): void {
    clearTimeout(subscription.timer)
    subscription.reader?.close()
    subscription.reader = undefined
    this.#clearCachedPage(connection, subscription)
  }

  #requireConnection(id: string): Connection {
    const connection = this.#connections.get(id)
    if (!connection)
      throw new ProductProtocolError('SYNC_INVALID')
    return connection
  }

  #enqueue(connection: Connection, subscription: Subscription, change: Change): boolean {
    if (subscription.items + change.count > PRODUCT_LIMITS.subscriptionItems || subscription.bytes + change.bytes > PRODUCT_LIMITS.subscriptionBytes) {
      this.#resync(connection, subscription)
      return false
    }
    if (connection.bytes + change.bytes > PRODUCT_LIMITS.connectionBytes) {
      this.#close(connection)
      return false
    }
    subscription.pending.push(change)
    subscription.items += change.count
    subscription.bytes += change.bytes
    connection.bytes += change.bytes
    return true
  }

  #flush(connection: Connection, subscription: Subscription): void {
    if (!subscription.active)
      return
    for (const change of subscription.pending) {
      if (change.to <= subscription.sent)
        continue
      const frame = encodeProductFrame({ jsonrpc: '2.0', method: 'sync.delta', params: { subscriptionId: subscription.id, syncEpoch: subscription.topic.epoch, fromSeq: encodeProductRevision(change.from), toSeq: encodeProductRevision(change.to), changes: change.changes } })
      if (!this.#send(connection, frame))
        return
      subscription.sent = change.to
    }
  }

  #resync(connection: Connection, subscription: Subscription): void {
    if (connection.subscriptions.get(subscription.id) !== subscription)
      return
    this.#releaseSnapshot(connection, subscription)
    connection.bytes -= subscription.bytes
    connection.subscriptions.delete(subscription.id)
    this.#send(connection, encodeProductFrame({ jsonrpc: '2.0', method: 'sync.resyncRequired', params: { subscriptionId: subscription.id, reason: 'RESYNC_REQUIRED' } }))
  }

  #send(connection: Connection, frame: string): boolean {
    try {
      if (connection.transport.send(frame))
        return true
    }
    catch {}
    this.#close(connection)
    return false
  }

  #close(connection: Connection): void {
    for (const [id, candidate] of this.#connections) {
      if (candidate === connection)
        this.#connections.delete(id)
    }
    for (const subscription of connection.subscriptions.values()) this.#releaseSnapshot(connection, subscription)
    connection.subscriptions.clear()
    connection.bytes = 0
    connection.transport.close()
  }
}
