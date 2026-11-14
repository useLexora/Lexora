import type { DatabaseSync } from 'node:sqlite'
import type { CommandDecision, CommandDecisionOutcome, CommandReceipt, CommandReceiptSnapshot, CommandRejection, StorageCommand } from '../storage/CommandCommitter'
import type { InputCommandIntent, InputCommandMethod, ProductCommandFingerprint } from './commandIntent'
import { z } from 'zod'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { assertSameCommand, CommandCommitter } from '../storage/CommandCommitter'
import { requireSqliteAuthority } from '../storage/sqliteAuthority'
import { getStorageIsolation } from '../storage/StorageIsolation'
import { assertCommittedRead, readTransactionFailure } from '../storage/transaction'
import { CommandAdmissionError, CommandResultUnknownError } from './CommandAdmissionError'
import { COMMAND_FINGERPRINT_VERSION, fingerprintCommandIntent, PRODUCT_COMMAND_FINGERPRINT_VERSION, productCommandFingerprint } from './commandIntent'

const id = z.string().min(1).max(256)
const identitySchema = z.object({ dataGeneration: id, commandId: id }).strict()
const submissionSchema = identitySchema.extend({ expectedServiceInstanceId: id, intent: z.unknown() }).strict()

export interface TrustedCommandPrincipal {
  readonly actorId: string
  assertAuthenticated: () => void
}

export interface CommandResolution {
  created: boolean
  receipt: CommandReceiptSnapshot
}

export type CommandLookup
  = | { lookup: 'decided', receipt: CommandReceiptSnapshot }
    | { lookup: 'pending' | 'not_found' }

export function createLocalCommandPrincipal(database: DatabaseSync): TrustedCommandPrincipal {
  assertCommittedRead(database)
  requireSqliteAuthority(database)
  const actorId = database.prepare('SELECT local_actor_id FROM storage_profile WHERE id = 1').get()?.local_actor_id
  if (typeof actorId !== 'string' || !actorId)
    throw new CommandAdmissionError('COMMAND_ACTOR_UNAVAILABLE')
  return Object.freeze({
    actorId,
    assertAuthenticated() {
      const current = database.prepare('SELECT local_actor_id FROM storage_profile WHERE id = 1').get()?.local_actor_id
      if (current !== actorId)
        throw new CommandAdmissionError('COMMAND_ACTOR_UNAVAILABLE')
    },
  })
}

export class CommandAdmissionService {
  readonly #database: DatabaseSync
  readonly #principal: TrustedCommandPrincipal
  readonly #sourceInstanceId: string
  readonly #committer: CommandCommitter
  readonly #stopping = new AbortController()
  readonly #pending = new Map<string, { command: StorageCommand, result: Promise<CommandResolution> }>()

  constructor(options: { database: DatabaseSync, principal: TrustedCommandPrincipal, sourceInstanceId: string }) {
    this.#database = options.database
    this.#principal = options.principal
    this.#sourceInstanceId = id.parse(options.sourceInstanceId)
    this.#committer = new CommandCommitter(options.database)
  }

  get hasPendingOperations(): boolean {
    return this.#pending.size > 0
  }

  lookup(input: unknown): CommandLookup {
    const identity = identitySchema.parse(input)
    const receipt = this.#read(identity)
    if (receipt)
      return { lookup: 'decided', receipt }
    return { lookup: this.#pending.has(this.#key(identity)) ? 'pending' : 'not_found' }
  }

  async execute<Method extends InputCommandMethod, Prepared>(
    method: Method,
    input: unknown,
    handlers: {
      prepare: (intent: Readonly<InputCommandIntent<Method>>, signal: AbortSignal) => Promise<Prepared>
      scope?: (intent: Readonly<InputCommandIntent<Method>>, operation: () => Promise<CommandResolution>) => Promise<CommandResolution>
      reject?: (error: unknown) => CommandRejection | null
      validate?: (prepared: Prepared, command: Readonly<StorageCommand>) => CommandRejection | null
      commit: (prepared: Prepared, command: Readonly<StorageCommand>) => CommandDecision
    },
  ): Promise<CommandResolution> {
    const submission = submissionSchema.parse(input)
    const intent = fingerprintCommandIntent(method, submission.intent)
    const fingerprint = (input as { [productCommandFingerprint]?: ProductCommandFingerprint })[productCommandFingerprint] ?? intent
    const command: StorageCommand = {
      dataGeneration: submission.dataGeneration,
      actorId: this.#principal.actorId,
      commandId: submission.commandId,
      method,
      fingerprintVersion: fingerprint.version,
      fingerprint: fingerprint.fingerprint,
      sourceInstanceId: this.#sourceInstanceId,
    }
    const previous = this.#read(command)
    if (previous) {
      this.#assertSameIntent(previous, command)
      return { created: false, receipt: previous }
    }
    this.#assertAdmission(submission.expectedServiceInstanceId)
    const key = this.#key(command)
    const waiting = this.#pending.get(key)
    if (waiting) {
      assertSameCommand(waiting.command, command)
      const result = await waiting.result
      return { created: false, receipt: result.receipt }
    }
    const snapshot = copyEventSnapshot(intent.intent as unknown) as Readonly<InputCommandIntent<Method>>
    const context = Object.freeze(command)
    const admit = (operation: () => CommandDecisionOutcome) => {
      try {
        this.#principal.assertAuthenticated()
        return this.#committer.decide(command, () => {
          this.#principal.assertAuthenticated()
          this.#assertAdmission(submission.expectedServiceInstanceId)
          return operation()
        })
      }
      catch (cause) {
        if (getStorageIsolation(this.#database).failure || readTransactionFailure(cause)?.outcome === 'unknown')
          throw new CommandResultUnknownError(cause)
        throw cause
      }
    }
    const operation = async () => {
      this.#assertAdmission(submission.expectedServiceInstanceId)
      const prepared = await handlers.prepare(snapshot, this.#stopping.signal)
      return admit(() => {
        const rejection = handlers.validate?.(prepared, context)
        return rejection ? { ...rejection, decision: 'rejected' } : { ...handlers.commit(prepared, context), decision: 'accepted' }
      })
    }
    const result = Promise.resolve().then(() => handlers.scope ? handlers.scope(snapshot, operation) : operation()).catch((error) => {
      if (error instanceof CommandResultUnknownError || getStorageIsolation(this.#database).failure || readTransactionFailure(error)?.outcome === 'unknown')
        throw error
      const rejection = handlers.reject?.(error)
      if (!rejection)
        throw error
      return admit(() => ({ ...rejection, decision: 'rejected' }))
    }).finally(() => {
      if (this.#pending.get(key)?.result === result)
        this.#pending.delete(key)
    })
    this.#pending.set(key, { command, result })
    return result
  }

  stopAccepting(): void {
    this.#stopping.abort(new CommandAdmissionError('SERVICE_STOPPING'))
  }

  async dispose(): Promise<void> {
    this.stopAccepting()
    await Promise.allSettled([...this.#pending.values()].map(pending => pending.result))
  }

  #assertAdmission(expectedInstance: string): void {
    if (this.#stopping.signal.aborted || this.#database.prepare('SELECT 1 FROM service_admission_gates WHERE source_instance_id = ?').get(this.#sourceInstanceId))
      throw new CommandAdmissionError('SERVICE_STOPPING')
    if (expectedInstance !== this.#sourceInstanceId)
      throw new CommandAdmissionError('SERVICE_INSTANCE_CHANGED')
  }

  #read(identity: { dataGeneration: string, commandId: string }) {
    try {
      this.#principal.assertAuthenticated()
      return this.#committer.find({ dataGeneration: identity.dataGeneration, commandId: identity.commandId, actorId: this.#principal.actorId })
    }
    catch (cause) {
      if (cause instanceof CommandAdmissionError)
        throw cause
      throw new CommandResultUnknownError(cause)
    }
  }

  #assertSameIntent(receipt: Pick<CommandReceipt, 'method' | 'fingerprintVersion' | 'fingerprint'>, command: StorageCommand): void {
    if (receipt.fingerprintVersion !== COMMAND_FINGERPRINT_VERSION && receipt.fingerprintVersion !== PRODUCT_COMMAND_FINGERPRINT_VERSION)
      throw new CommandAdmissionError('COMMAND_FINGERPRINT_UNSUPPORTED')
    assertSameCommand(receipt, command)
  }

  #key(identity: { dataGeneration: string, commandId: string }): string {
    return JSON.stringify([identity.dataGeneration, this.#principal.actorId, identity.commandId])
  }
}
