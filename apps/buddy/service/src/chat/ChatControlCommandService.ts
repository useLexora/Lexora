import type { DatabaseSync } from 'node:sqlite'
import type { CommandAdmissionService, CommandResolution } from '../commands/CommandAdmissionService'
import type { InputCommandIntent } from '../commands/commandIntent'
import type { ChatControlCommandRepository } from '../storage/ChatControlCommandRepository'
import type { CommandDecision, CommandRejection, StorageCommand } from '../storage/CommandCommitter'
import type { ChatQueueService } from './ChatQueueService'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { ChatControlConflictError } from '../storage/ChatControlCommandRepository'
import { afterTransactionCommit } from '../storage/transaction'

export type ChatControlCommandMethod = 'chat.queue.cancel' | 'chat.queue.steer' | 'chat.queue.continue' | 'chat.cancel' | 'runtime.stop'

interface PreparedControl {
  commit: (command: Readonly<StorageCommand>) => { decision: CommandDecision, notify: () => void | Promise<unknown> }
}

interface ChatControlCommandServiceOptions {
  database: DatabaseSync
  admission: Pick<CommandAdmissionService, 'execute'>
  repository: ChatControlCommandRepository
  queue: Pick<ChatQueueService, 'prepareContinue' | 'commitContinue' | 'prepareSteer' | 'commitSteer' | 'publishCancelled' | 'cancelRun'>
  onServiceStop: (runIds: readonly string[]) => void | Promise<void>
  onDispatchError: (error: unknown) => void
}

export class ChatControlCommandService {
  readonly #options: ChatControlCommandServiceOptions
  readonly #effects = new Set<Promise<void>>()

  constructor(options: ChatControlCommandServiceOptions) {
    this.#options = options
  }

  execute(method: ChatControlCommandMethod, input: unknown): Promise<CommandResolution> {
    return this.#options.admission.execute(method, input, {
      prepare: (intent, signal) => this.#prepare(method, intent, signal),
      reject: rejectControl,
      commit: (prepared, command) => {
        const committed = prepared.commit(command)
        afterTransactionCommit(this.#options.database, () => this.#notify(committed.notify), this.#options.onDispatchError)
        return committed.decision
      },
    })
  }

  async waitForEffects(): Promise<void> {
    await Promise.allSettled(this.#effects)
  }

  async #prepare(method: ChatControlCommandMethod, intent: Readonly<InputCommandIntent<ChatControlCommandMethod>>, signal: AbortSignal): Promise<PreparedControl> {
    signal.throwIfAborted()
    const repository = this.#options.repository
    switch (method) {
      case 'chat.queue.cancel': {
        const target = intent as InputCommandIntent<'chat.queue.cancel'>
        return { commit: () => {
          repository.cancelQueue(target)
          return { decision: { target: { queueId: target.id, conversationId: target.conversationId, branchId: target.branchId }, result: { cancelled: true } }, notify: () => this.#options.queue.publishCancelled(target) }
        } }
      }
      case 'chat.queue.continue': {
        const target = intent as InputCommandIntent<'chat.queue.continue'>
        repository.assertQueue(target)
        const prepared = await this.#options.queue.prepareContinue(target)
        signal.throwIfAborted()
        return { commit: () => repository.withQueue(target, () => {
          const committed = this.#options.queue.commitContinue(prepared)
          return {
            decision: { target: { queueId: target.id, conversationId: target.conversationId, branchId: target.branchId, runId: committed.request.runId }, result: { requestId: committed.request.requestId } },
            notify: committed.notify,
          }
        }) }
      }
      case 'chat.queue.steer': {
        const target = intent as InputCommandIntent<'chat.queue.steer'>
        repository.assertQueue(target)
        repository.assertRun({ runId: target.targetRunId, expectedRunGeneration: target.expectedRunGeneration }, true)
        const prepared = await this.#options.queue.prepareSteer(target, target.targetRunId)
        signal.throwIfAborted()
        return { commit: () => repository.withQueue(target, () => {
          repository.assertRun({ runId: target.targetRunId, expectedRunGeneration: target.expectedRunGeneration }, true)
          const deliver = this.#options.queue.commitSteer(prepared)
          repository.recordDelivery(target.id, target.targetRunId)
          return {
            decision: { target: { queueId: target.id, conversationId: target.conversationId, branchId: target.branchId, runId: target.targetRunId }, result: { deliveryStage: 'committed' } },
            notify: () => {
              let stage: 'submitted' | 'unavailable' | 'unknown' = 'unknown'
              try {
                stage = deliver() ? 'submitted' : 'unavailable'
              }
              finally {
                repository.observeDelivery(target.id, stage)
              }
            },
          }
        }) }
      }
      case 'chat.cancel': {
        const target = intent as InputCommandIntent<'chat.cancel'>
        return { commit: () => {
          const decision = repository.cancelRun(target)
          return { decision, notify: () => decision.result.cancelRequested ? this.#options.queue.cancelRun(target.runId) : undefined }
        } }
      }
      case 'runtime.stop': {
        const target = intent as InputCommandIntent<'runtime.stop'>
        return { commit: (command) => {
          const decision = repository.stopService(target, command.commandId)
          return { decision, notify: () => target.scope === 'stop_service' ? this.#options.onServiceStop(decision.result.runIds) : undefined }
        } }
      }
    }
  }

  #notify(operation: () => void | Promise<unknown>): void {
    const effect = Promise.resolve().then(operation).then(() => {}, this.#options.onDispatchError).finally(() => this.#effects.delete(effect))
    this.#effects.add(effect)
  }
}

function rejectControl(error: unknown): CommandRejection | null {
  if (error instanceof ChatControlConflictError)
    return { errorCode: error.code, target: {}, result: {} }
  if (error instanceof BuddyServiceError && (error.code === 'INPUT_DELIVERY_INCOMPATIBLE' || error.code === 'INPUT_DELIVERY_TARGET_UNAVAILABLE'))
    return { errorCode: error.code, target: {}, result: {} }
  return null
}
