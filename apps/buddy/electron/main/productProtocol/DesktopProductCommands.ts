import type { ProductIdentity } from '../../../shared/productProtocol/identity'
import type { ProductCommandMethod } from '../../../shared/productProtocol/methods'
import type { ProductOutboxRecord, ProductOutboxStore, ProductRecoveryInput } from './ProductOutboxStore'
import { productCommandLookupSchema, productCommandResultSchema } from '../../../shared/productProtocol/receipts'
import { isProductOutboxOwner } from './ProductOutboxStore'

export interface DesktopProductConnection {
  readonly identity: ProductIdentity
  request: (method: string, params: unknown) => Promise<unknown>
}
export interface DesktopCommandOutcome {
  state: 'decided' | 'not_accepted' | 'unknown' | 'trust_changed' | 'connection_replaced'
  record: ProductOutboxRecord
}

export class DesktopProductCommands {
  #connection: DesktopProductConnection | null = null
  #commands = new Map<string, Promise<DesktopCommandOutcome>>()

  readonly outbox: ProductOutboxStore

  constructor(outbox: ProductOutboxStore) {
    this.outbox = outbox
  }

  attach(connection: DesktopProductConnection): () => void {
    this.#connection = connection
    return () => {
      if (this.#connection === connection)
        this.#connection = null
    }
  }

  execute(input: { method: ProductCommandMethod, commandId: string, intent: unknown, recovery?: ProductRecoveryInput }): Promise<DesktopCommandOutcome> {
    const connection = this.#connection
    if (!connection)
      return Promise.reject(new Error('PRODUCT_CONNECTION_UNAVAILABLE'))
    const key = commandKey(connection.identity, input.commandId)
    const prior = this.#commands.get(key)
    const run = () => this.#execute(connection, input)
    const next = prior ? prior.then(run, run) : run()
    this.#commands.set(key, next)
    void next.finally(() => {
      if (this.#commands.get(key) === next)
        this.#commands.delete(key)
    }).catch(() => {})
    return next
  }

  async #execute(connection: DesktopProductConnection, input: { method: ProductCommandMethod, commandId: string, intent: unknown, recovery?: ProductRecoveryInput }): Promise<DesktopCommandOutcome> {
    const { created, record } = await this.outbox.create({
      identity: connection.identity,
      method: input.method,
      envelope: { commandId: input.commandId, dataGeneration: connection.identity.dataGeneration, expectedServiceInstanceId: connection.identity.serviceInstanceId, intent: input.intent },
      recovery: input.recovery,
    })
    if (!created)
      return this.#reconcile(record)
    if (this.#connection !== connection)
      return { state: 'connection_replaced', record }
    const uncertain = await this.outbox.markUncertain(record)
    if (this.#connection !== connection)
      return { state: 'connection_replaced', record: uncertain }
    try {
      const result = productCommandResultSchema.parse(await connection.request(record.method, record.envelope))
      const decided = await this.outbox.decide(uncertain, result.receipt)
      return { state: this.#connection === connection ? 'decided' : 'connection_replaced', record: decided }
    }
    catch {
      return { state: this.#connection === connection ? 'unknown' : 'connection_replaced', record: uncertain }
    }
  }

  async reconcile(record: ProductOutboxRecord): Promise<DesktopCommandOutcome> {
    const pending = this.#commands.get(commandKey(record.owner, record.commandId))
    if (pending)
      await pending.catch(() => {})
    return this.#reconcile(await this.outbox.read(record.owner, record.commandId) ?? record)
  }

  async #reconcile(record: ProductOutboxRecord): Promise<DesktopCommandOutcome> {
    const connection = this.#connection
    if (!connection)
      return { state: 'unknown', record }
    if (!isProductOutboxOwner(record.owner, connection.identity))
      return { state: 'trust_changed', record }
    if (record.state === 'decided')
      return { state: 'decided', record }
    try {
      const result = productCommandLookupSchema.parse(await connection.request('commands.get', { dataGeneration: record.owner.dataGeneration, commandId: record.commandId }))
      if (this.#connection !== connection)
        return { state: 'connection_replaced', record }
      if (result.lookup === 'decided') {
        const decided = await this.outbox.decide(record, result.receipt)
        return { state: this.#connection === connection ? 'decided' : 'connection_replaced', record: decided }
      }
      if (result.lookup === 'not_found') {
        const absent = await this.outbox.confirmAbsent(record)
        return { state: this.#connection === connection ? 'not_accepted' : 'connection_replaced', record: absent }
      }
      return { state: 'unknown', record }
    }
    catch {
      return { state: this.#connection === connection ? 'unknown' : 'connection_replaced', record }
    }
  }

  async recover(): Promise<DesktopCommandOutcome[]> {
    const outcomes: DesktopCommandOutcome[] = []
    for (const record of await this.outbox.list()) {
      if (record.envelope || record.recovery)
        outcomes.push(await this.reconcile(record))
    }
    return outcomes
  }
}

function commandKey(owner: Pick<ProductIdentity, 'serviceId' | 'profileId' | 'dataGeneration' | 'deviceId'>, commandId: string): string {
  return JSON.stringify([owner.serviceId, owner.profileId, owner.dataGeneration, owner.deviceId, commandId])
}
