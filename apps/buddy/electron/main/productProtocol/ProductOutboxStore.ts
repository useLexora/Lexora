import type { ProductIdentity } from '../../../shared/productProtocol/identity'
import type { ProductCommandMethod } from '../../../shared/productProtocol/methods'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { isMissing, readStorageJson, syncStorageDirectory, writeStorageJson } from '../../../platform/storage/storageFiles'
import { buddyUserContentV1Schema } from '../../../shared/conversation/buddyUserContent'
import { buddyComposerDraftExecutionConfigSchema, buddyComposerDraftModelSelectionSchema, buddyDraftParticipantsSchema } from '../../../shared/conversation/composerDraft'
import { productIdentitySchema } from '../../../shared/productProtocol/identity'
import { PRODUCT_LIMITS } from '../../../shared/productProtocol/limits'
import { getProductMethod } from '../../../shared/productProtocol/methods'
import { productCommandReceiptSchema } from '../../../shared/productProtocol/receipts'
import { productIdSchema, productRevisionSchema } from '../../../shared/productProtocol/scalars'

const ownerSchema = productIdentitySchema.pick({ serviceId: true, profileId: true, dataGeneration: true, deviceId: true })
const envelopeSchema = z.object({ dataGeneration: productIdSchema, commandId: productIdSchema, expectedServiceInstanceId: productIdSchema, intent: z.unknown() }).strict()
const recoverySchema = z.object({ draftId: productIdSchema, editSequence: productRevisionSchema, content: buddyUserContentV1Schema, executionConfig: buddyComposerDraftExecutionConfigSchema.optional(), modelSelection: buddyComposerDraftModelSelectionSchema.nullable().optional(), participants: buddyDraftParticipantsSchema.nullable().optional() }).strict()
const recordSchema = z.object({
  version: z.literal(1),
  owner: ownerSchema,
  commandId: productIdSchema,
  method: productIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  state: z.enum(['prepared', 'uncertain', 'not_accepted', 'decided']),
  envelope: envelopeSchema.nullable(),
  recovery: recoverySchema.nullable(),
  receipt: productCommandReceiptSchema.nullable(),
}).strict().refine(record => (record.state === 'decided') === (record.receipt !== null))
export type ProductOutboxRecord = z.infer<typeof recordSchema>
export type ProductOutboxOwner = z.infer<typeof ownerSchema>
export type ProductRecoveryInput = z.infer<typeof recoverySchema>
export type ProductOutboxEnvelope = z.infer<typeof envelopeSchema>
const maxRecordBytes = PRODUCT_LIMITS.frameBytes * 2

export class ProductOutboxStore {
  #tail: Promise<unknown> = Promise.resolve()

  readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  create(input: { identity: ProductIdentity, method: ProductCommandMethod, envelope: ProductOutboxEnvelope, recovery?: ProductRecoveryInput }): Promise<{ created: boolean, record: ProductOutboxRecord }> {
    const method = getProductMethod(input.method)
    if (!method?.command)
      throw new Error('OUTBOX_INVALID_METHOD')
    const envelope = envelopeSchema.parse(method.input.parse(input.envelope))
    const owner = ownerSchema.parse({ serviceId: input.identity.serviceId, profileId: input.identity.profileId, dataGeneration: input.identity.dataGeneration, deviceId: input.identity.deviceId })
    if (envelope.dataGeneration !== owner.dataGeneration)
      throw new Error('OUTBOX_IDENTITY_CHANGED')
    const fingerprint = digest({ method: input.method, dataGeneration: envelope.dataGeneration, commandId: envelope.commandId, intent: envelope.intent })
    const record = recordSchema.parse({ version: 1, owner, commandId: envelope.commandId, method: input.method, fingerprint, createdAt: new Date().toISOString(), state: 'prepared', envelope, recovery: input.recovery ?? null, receipt: null })
    return this.#serial(async () => {
      const existing = await this.#read(owner, envelope.commandId)
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error('OUTBOX_COMMAND_ID_REUSED')
        return { created: false, record: existing }
      }
      await this.#write(record)
      return { created: true, record }
    })
  }

  read(owner: ProductOutboxOwner, commandId: string): Promise<ProductOutboxRecord | null> {
    return this.#serial(() => this.#read(ownerSchema.parse(owner), productIdSchema.parse(commandId)))
  }

  list(): Promise<ProductOutboxRecord[]> {
    return this.#serial(async () => {
      const names = await readdir(this.directory).catch((error) => {
        if (!isMissing(error))
          throw error
        return []
      })
      const records: ProductOutboxRecord[] = []
      for (const name of names.sort()) {
        if (!/^[a-f0-9]{64}\.json$/.test(name))
          continue
        const record = recordSchema.parse(await readStorageJson(join(this.directory, name), maxRecordBytes))
        if (name !== recordName(record.owner, record.commandId))
          throw new Error('OUTBOX_IDENTITY_CHANGED')
        validateRecord(record)
        records.push(record)
      }
      return records
    })
  }

  markUncertain(record: ProductOutboxRecord): Promise<ProductOutboxRecord> {
    return this.#update(record, current => current.state === 'prepared' ? { ...current, state: 'uncertain' } : current)
  }

  confirmAbsent(record: ProductOutboxRecord): Promise<ProductOutboxRecord> {
    return this.#update(record, current => current.state === 'decided' ? current : { ...current, state: 'not_accepted' })
  }

  decide(record: ProductOutboxRecord, receipt: z.infer<typeof productCommandReceiptSchema>): Promise<ProductOutboxRecord> {
    const parsed = productCommandReceiptSchema.parse(receipt)
    if (parsed.dataGeneration !== record.owner.dataGeneration || parsed.commandId !== record.commandId || parsed.method !== record.method)
      throw new Error('OUTBOX_RECEIPT_MISMATCH')
    return this.#update(record, (current) => {
      if (current.receipt && digest(current.receipt) !== digest(parsed))
        throw new Error('OUTBOX_RECEIPT_CHANGED')
      return { ...current, state: 'decided', receipt: parsed }
    })
  }

  archive(record: ProductOutboxRecord): Promise<ProductOutboxRecord> {
    return this.#serial(async () => {
      const current = await this.#read(record.owner, record.commandId)
      if (!current || current.fingerprint !== record.fingerprint)
        throw new Error('OUTBOX_RECORD_CHANGED')
      if (current.state !== 'decided' && current.state !== 'not_accepted')
        throw new Error('OUTBOX_NOT_RECONCILED')
      const archived = recordSchema.parse({ ...current, envelope: null, recovery: null })
      const name = recordName(current.owner, current.commandId)
      await writeStorageJson(join(this.directory, 'archive', name), archived)
      await unlink(join(this.directory, name)).catch((error) => {
        if (!isMissing(error))
          throw error
      })
      await syncStorageDirectory(this.directory)
      return archived
    })
  }

  #update(record: ProductOutboxRecord, update: (current: ProductOutboxRecord) => ProductOutboxRecord): Promise<ProductOutboxRecord> {
    return this.#serial(async () => {
      const current = await this.#read(record.owner, record.commandId)
      if (!current || current.fingerprint !== record.fingerprint)
        throw new Error('OUTBOX_RECORD_CHANGED')
      const next = recordSchema.parse(update(current))
      await this.#write(next)
      return next
    })
  }

  async #read(owner: ProductOutboxOwner, commandId: string): Promise<ProductOutboxRecord | null> {
    const name = recordName(owner, commandId)
    const raw = await readStorageJson(join(this.directory, name), maxRecordBytes) ?? await readStorageJson(join(this.directory, 'archive', name), maxRecordBytes)
    if (raw === null)
      return null
    const record = recordSchema.parse(raw)
    if (digest(record.owner) !== digest(owner) || record.commandId !== commandId)
      throw new Error('OUTBOX_IDENTITY_CHANGED')
    validateRecord(record)
    return record
  }

  async #write(record: ProductOutboxRecord): Promise<void> {
    validateRecord(record)
    if (Buffer.byteLength(JSON.stringify(record)) > maxRecordBytes)
      throw new Error('OUTBOX_INPUT_TOO_LARGE')
    await writeStorageJson(join(this.directory, recordName(record.owner, record.commandId)), record)
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation)
    this.#tail = next
    return next
  }
}

export function isProductOutboxOwner(owner: ProductOutboxOwner, identity: ProductIdentity): boolean {
  return owner.serviceId === identity.serviceId && owner.profileId === identity.profileId && owner.dataGeneration === identity.dataGeneration && owner.deviceId === identity.deviceId
}

function validateRecord(record: ProductOutboxRecord): void {
  if (!record.envelope && (record.state === 'prepared' || record.state === 'uncertain'))
    throw new Error('OUTBOX_INPUT_MISSING')
  if (record.envelope && (record.envelope.commandId !== record.commandId || record.envelope.dataGeneration !== record.owner.dataGeneration
    || digest({ method: record.method, dataGeneration: record.envelope.dataGeneration, commandId: record.commandId, intent: record.envelope.intent }) !== record.fingerprint)) {
    throw new Error('OUTBOX_INTENT_CHANGED')
  }
  if (record.receipt && (record.receipt.commandId !== record.commandId || record.receipt.dataGeneration !== record.owner.dataGeneration || record.receipt.method !== record.method))
    throw new Error('OUTBOX_RECEIPT_MISMATCH')
}
function recordName(owner: ProductOutboxOwner, commandId: string): string {
  return `${digest({ ...owner, commandId })}.json`
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]))
  return value
}

export function productOutboxRecordId(record: ProductOutboxRecord): string {
  return digest({ owner: record.owner, commandId: record.commandId })
}
