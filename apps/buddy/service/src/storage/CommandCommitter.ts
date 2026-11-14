import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { CommandAdmissionError } from '../commands/CommandAdmissionError'
import { requireSqliteAuthority } from './sqliteAuthority'
import { getStorageIsolation } from './StorageIsolation'
import { assertCommittedRead, withTransaction } from './transaction'

const objectSchema = z.record(z.string(), z.json())
const commandSchema = z.object({
  dataGeneration: z.string().min(1),
  actorId: z.string().min(1),
  commandId: z.string().min(1),
  method: z.string().min(1),
  fingerprintVersion: z.number().int().positive(),
  fingerprint: z.string().min(1),
  sourceInstanceId: z.string().min(1),
}).strict()
const receiptSchema = commandSchema.extend({
  decision: z.literal('accepted'),
  target: objectSchema,
  result: objectSchema,
  decidedAt: z.iso.datetime(),
}).or(commandSchema.extend({
  decision: z.literal('rejected'),
  target: objectSchema,
  result: objectSchema,
  errorCode: z.string().min(1),
  decidedAt: z.iso.datetime(),
}))

export type StorageCommand = z.infer<typeof commandSchema>
export type CommandReceipt = z.infer<typeof receiptSchema>
export type CommandDecision = Pick<CommandReceipt, 'target' | 'result'>
type ReceiptSnapshot<Receipt extends CommandReceipt> = Receipt extends unknown
  ? Readonly<Omit<Receipt, 'target' | 'result'>> & { readonly target: Readonly<CommandDecision['target']>, readonly result: Readonly<CommandDecision['result']> }
  : never
export type CommandReceiptSnapshot = ReceiptSnapshot<CommandReceipt>

const rejectionSchema = z.object({
  errorCode: z.enum(['DRAFT_CONFLICT', 'SOURCE_CHANGED', 'QUEUE_CHANGED', 'REVIEW_CHANGED', 'APPROVAL_ALREADY_RESOLVED', 'QUESTION_CLOSED', 'QUESTION_STALE', 'QUESTION_NOT_FOUND', 'QUESTION_ANSWER_INVALID', 'RESOURCE_UNAVAILABLE', 'OBJECT_DELETED', 'DESKTOP_UNAVAILABLE', 'INPUT_DELIVERY_TARGET_UNAVAILABLE', 'INPUT_DELIVERY_INCOMPATIBLE']),
  target: objectSchema,
  result: objectSchema,
}).strict()

const decisionSchema = z.object({ decision: z.literal('accepted'), target: objectSchema, result: objectSchema }).strict().or(rejectionSchema.extend({ decision: z.literal('rejected') }))

export type CommandRejection = z.infer<typeof rejectionSchema>
export type CommandDecisionOutcome = CommandDecision & ({ decision: 'accepted' } | ({ decision: 'rejected' } & Pick<CommandRejection, 'errorCode'>))

export function assertSameCommand(receipt: Pick<CommandReceipt, 'method' | 'fingerprintVersion' | 'fingerprint'>, intent: Pick<StorageCommand, 'method' | 'fingerprintVersion' | 'fingerprint'>): void {
  if (receipt.method !== intent.method || receipt.fingerprintVersion !== intent.fingerprintVersion || receipt.fingerprint !== intent.fingerprint)
    throw new CommandAdmissionError('COMMAND_ID_REUSED', 'Command identity conflicts with its recorded intent')
}

export class CommandCommitter {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    requireSqliteAuthority(database)
    this.#database = database
  }

  accept(command: StorageCommand, operation: () => CommandDecision) {
    return this.#commit(command, () => ({ ...operation(), decision: 'accepted' }))
  }

  reject(command: StorageCommand, rejection: CommandRejection) {
    const decision = rejectionSchema.parse(rejection)
    return this.#commit(command, () => ({ ...decision, decision: 'rejected' }))
  }

  decide(command: StorageCommand, operation: () => CommandDecisionOutcome) {
    return this.#commit(command, operation)
  }

  #commit(command: StorageCommand, operation: () => CommandDecisionOutcome) {
    return withTransaction(this.#database, () => {
      const intent = commandSchema.parse(command)
      this.#validateIdentity(intent)
      const previous = this.#find(intent)
      if (previous) {
        assertSameCommand(previous, intent)
        return { created: false, receipt: previous }
      }
      const decision = decisionSchema.parse(withTransaction(this.#database, operation))
      const receipt = receiptSchema.parse({
        ...intent,
        ...decision,
        decidedAt: new Date().toISOString(),
      })
      this.#database.prepare(`
        INSERT INTO command_receipts (
          data_generation, actor_id, command_id, method, fingerprint_version,
          fingerprint, source_instance_id, decision, target_json, result_json, error_code, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(receipt.dataGeneration, receipt.actorId, receipt.commandId, receipt.method, receipt.fingerprintVersion, receipt.fingerprint, receipt.sourceInstanceId, receipt.decision, JSON.stringify(receipt.target), JSON.stringify(receipt.result), receipt.decision === 'rejected' ? receipt.errorCode : null, receipt.decidedAt)
      return { created: true, receipt: copyEventSnapshot(receipt) as unknown as CommandReceiptSnapshot }
    })
  }

  find(identity: Pick<StorageCommand, 'dataGeneration' | 'actorId' | 'commandId'>) {
    assertCommittedRead(this.#database)
    this.#validateIdentity(identity)
    return this.#find(identity)
  }

  #validateIdentity(identity: Pick<StorageCommand, 'dataGeneration' | 'actorId'>): void {
    if (requireSqliteAuthority(this.#database).dataGeneration !== identity.dataGeneration)
      throw new CommandAdmissionError('DATA_GENERATION_CHANGED', 'Command data generation is not current')
    if (!this.#database.prepare('SELECT 1 FROM storage_actors WHERE id = ? AND state = \'active\'').get(identity.actorId))
      throw new CommandAdmissionError('COMMAND_ACTOR_UNAVAILABLE', 'Command actor is not active')
  }

  #find(identity: Pick<StorageCommand, 'dataGeneration' | 'actorId' | 'commandId'>) {
    try {
      return this.#readReceipt(identity)
    }
    catch (error) {
      getStorageIsolation(this.#database).isolate(error)
      throw error
    }
  }

  #readReceipt(identity: Pick<StorageCommand, 'dataGeneration' | 'actorId' | 'commandId'>) {
    const row = this.#database.prepare(`
      SELECT * FROM command_receipts WHERE data_generation = ? AND actor_id = ? AND command_id = ?
    `).get(identity.dataGeneration, identity.actorId, identity.commandId)
    if (!row)
      return null
    return copyEventSnapshot(receiptSchema.parse({
      dataGeneration: row.data_generation,
      actorId: row.actor_id,
      commandId: row.command_id,
      method: row.method,
      fingerprintVersion: row.fingerprint_version,
      fingerprint: row.fingerprint,
      sourceInstanceId: row.source_instance_id,
      decision: row.decision,
      target: JSON.parse(String(row.target_json)),
      result: JSON.parse(String(row.result_json)),
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
      decidedAt: row.decided_at,
    })) as unknown as CommandReceiptSnapshot
  }
}
