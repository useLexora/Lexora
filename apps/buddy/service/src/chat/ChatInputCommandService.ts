import type { DatabaseSync } from 'node:sqlite'
import type { SubmittedInput } from '../../../shared/conversation/submittedInput'
import type { CommandAdmissionService, CommandResolution } from '../commands/CommandAdmissionService'
import type { InputCommandIntent } from '../commands/commandIntent'
import type { CommandDecision, CommandRejection, StorageCommand } from '../storage/CommandCommitter'
import type { ChatCommandService } from './ChatCommandService'
import type { ChatQueueService } from './ChatQueueService'
import type { ChatTurnService } from './ChatTurnService'
import type { ComposerDraftService } from './ComposerDraftService'
import type { PreparedTurnAttachments } from './persistPreparedTurn'
import type { PreparedRunCommandService } from './PreparedRunCommandService'
import { randomUUID } from 'node:crypto'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { CommandRequestConflictError } from '../storage/commandRequestRepository'
import { ComposerDraftCommitConflictError } from '../storage/commitComposerDraft'
import { ComposerDraftConflictError } from '../storage/composerDraftRepository'
import { afterTransactionCommit } from '../storage/transaction'
import { TurnRequestConflictError } from '../storage/turnRequestRepository'
import { isPreparedResourceResultUnknown, PreparedResourceSettlement } from './PreparedResourceSettlement'
import { inputResourceOwner } from './resolveChatInput'

export type ChatInputCommandMethod = 'chat.submitInput' | 'chat.startTurn' | 'chat.editUserMessage' | 'chat.regenerateAssistant' | 'chat.executeCommand' | 'chat.queue.enqueue'

interface ChatInputCommandServiceOptions {
  database: DatabaseSync
  actorId?: string
  assertExecutionAvailable?: () => void
  admission: Pick<CommandAdmissionService, 'execute' | 'lookup'>
  drafts: Pick<ComposerDraftService, 'run' | 'find'>
  turns: Pick<ChatTurnService, 'prepareStart' | 'prepareEdit' | 'prepareRegenerate' | 'launchAccepted'>
  compact: Pick<ChatCommandService, 'prepare'>
  queue: Pick<ChatQueueService, 'prepareEnqueue' | 'commitEnqueue' | 'publishEnqueued'>
  preparedRuns: Pick<PreparedRunCommandService, 'commitStart' | 'commitEdit' | 'commitRegenerate' | 'commitCompact'>
  commitSubmittedInput?: (input: SubmittedInput) => void
  onDispatchError: (error: unknown) => void
}

interface PreparedInputCommand {
  submitted?: SubmittedInput
  attachments: PreparedTurnAttachments | null
  validate: () => CommandRejection | null
  commit: (command: Readonly<StorageCommand>) => { dispatch: () => void | Promise<void>, decision: CommandDecision }
}

export class ChatInputCommandService {
  readonly #options: ChatInputCommandServiceOptions
  readonly #dispatches = new Set<Promise<void>>()

  constructor(options: ChatInputCommandServiceOptions) {
    this.#options = options
  }

  lookup(input: unknown) {
    return this.#options.admission.lookup(input)
  }

  async execute(method: ChatInputCommandMethod, input: unknown): Promise<CommandResolution> {
    let resources: PreparedResourceSettlement | undefined
    try {
      const resolution = await this.#options.admission.execute(method, input, {
        scope: (intent, operation) => 'draftId' in intent ? this.#options.drafts.run(intent.draftId, operation) : operation(),
        prepare: async (intent, signal) => {
          signal.throwIfAborted()
          this.#options.assertExecutionAvailable?.()
          if ('draftId' in intent && this.#options.actorId && !this.#ownsDraft(intent.draftId))
            throw new ComposerDraftConflictError()
          if ('input' in intent && intent.input.legacyResourceDraftId && !this.#ownsDraft(intent.input.legacyResourceDraftId))
            throw new ComposerDraftConflictError()
          const prepared = await this.#prepare(method, intent)
          resources = new PreparedResourceSettlement(prepared.attachments, this.#options.onDispatchError)
          if ('input' in intent)
            prepared.submitted = intent.input
          signal.throwIfAborted()
          return prepared
        },
        reject: rejectInputCommand,
        validate: value => value.validate(),
        commit: (value, command) => {
          this.#options.assertExecutionAvailable?.()
          const accepted = value.commit(command)
          if (value.submitted)
            this.#options.commitSubmittedInput?.(value.submitted)
          afterTransactionCommit(this.#options.database, () => {
            this.#dispatch(resources!.commit(), accepted.dispatch)
          }, this.#options.onDispatchError)
          return accepted.decision
        },
      })
      await resources?.rollback()
      return resolution
    }
    catch (error) {
      await resources?.fail(error)
      throw error
    }
  }

  async waitForDispatches(): Promise<void> {
    await Promise.allSettled(this.#dispatches)
  }

  async #prepare(method: ChatInputCommandMethod, intent: Readonly<InputCommandIntent<ChatInputCommandMethod>>): Promise<PreparedInputCommand> {
    const validateSource = this.#captureSource(intent)
    const requestId = randomUUID()
    const submitted = 'input' in intent ? { ...intent.input, resourceOwnerId: inputResourceOwner(this.#options.actorId!, intent.input.inputId) } : null
    if (submitted && !this.#options.actorId)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const operation = 'operation' in intent ? ({ start: 'chat.startTurn', edit: 'chat.editUserMessage', enqueue: 'chat.queue.enqueue', command: 'chat.executeCommand' } as const)[intent.operation] : method
    switch (operation) {
      case 'chat.startTurn': {
        const input = submitted ? { snapshot: submitted, ...('buddyId' in intent ? { buddyId: intent.buddyId } : {}), ...('delivery' in intent ? { delivery: intent.delivery } : {}) } : intent as InputCommandIntent<'chat.startTurn'>
        if (input.delivery?.target)
          throw new BuddyServiceError('INPUT_DELIVERY_INCOMPATIBLE')
        const prepared = await this.#options.turns.prepareStart({ ...input, requestId })
        return {
          attachments: prepared.stagedAttachments,
          validate: () => this.#validate(prepared.stagedAttachments, validateSource),
          commit: command => this.#acceptedRun(this.#options.preparedRuns.commitStart(command.fingerprint, prepared.prepared)),
        }
      }
      case 'chat.editUserMessage': {
        if (submitted && submitted.scope.kind !== 'message_edit')
          throw new BuddyServiceError('VALIDATION_FAILED')
        const input = submitted && submitted.scope.kind === 'message_edit' ? { snapshot: submitted, conversationId: submitted.scope.conversationId, userMessageId: submitted.scope.userMessageId } : intent as InputCommandIntent<'chat.editUserMessage'>
        const prepared = await this.#options.turns.prepareEdit({ ...input, requestId })
        return {
          attachments: prepared.stagedAttachments,
          validate: () => this.#validate(prepared.stagedAttachments, validateSource),
          commit: command => this.#acceptedRun(this.#options.preparedRuns.commitEdit(command.fingerprint, prepared.prepared)),
        }
      }
      case 'chat.regenerateAssistant': {
        const prepared = await this.#options.turns.prepareRegenerate({ ...intent as InputCommandIntent<'chat.regenerateAssistant'>, requestId })
        return { attachments: null, validate: validateSource, commit: command => this.#acceptedRun(this.#options.preparedRuns.commitRegenerate(command.fingerprint, prepared)) }
      }
      case 'chat.queue.enqueue': {
        const input = submitted ? { snapshot: submitted, ...('delivery' in intent ? { delivery: intent.delivery } : {}) } : intent as InputCommandIntent<'chat.queue.enqueue'>
        const prepared = await this.#options.queue.prepareEnqueue({ ...input, requestId })
        return {
          attachments: prepared.stagedAttachments,
          validate: () => this.#validate(prepared.stagedAttachments, validateSource),
          commit: (command) => {
            const accepted = this.#options.queue.commitEnqueue(prepared.prepared, command.fingerprint)
            return {
              decision: { target: { queueId: accepted.id, conversationId: accepted.conversationId, branchId: accepted.branchId }, result: { draftReceipt: accepted.draftReceipt } },
              dispatch: () => this.#options.queue.publishEnqueued(prepared.prepared, accepted),
            }
          },
        }
      }
      case 'chat.executeCommand': {
        const input = submitted ? { snapshot: submitted } : intent as InputCommandIntent<'chat.executeCommand'>
        const prepared = this.#options.compact.prepare({ ...input, requestId })
        return { attachments: null, validate: validateSource, commit: command => this.#acceptedRun(this.#options.preparedRuns.commitCompact(command.fingerprint, prepared)) }
      }
      default: throw new BuddyServiceError('VALIDATION_FAILED')
    }
  }

  #captureSource(intent: Readonly<InputCommandIntent<ChatInputCommandMethod>>): () => CommandRejection | null {
    const scope = 'input' in intent ? intent.input.scope : 'draftId' in intent ? this.#options.drafts.find(intent.draftId)?.scope : null
    const conversationId = 'conversationId' in intent ? intent.conversationId : scope && 'conversationId' in scope ? scope.conversationId : null
    const readConversation = () => conversationId ? this.#options.database.prepare('SELECT deleted_at FROM conversations WHERE id = ?').get(conversationId) : null
    const readSource = () => 'sourceRunId' in intent ? this.#options.database.prepare('SELECT conversation_id, branch_id, triggering_message_id, status, generation FROM runs WHERE id = ?').get(intent.sourceRunId) : null
    const currentConversation = readConversation()
    if (scope && 'branchId' in scope && (!currentConversation || currentConversation.deleted_at !== null
      || !this.#options.database.prepare('SELECT 1 FROM conversation_branches WHERE id = ? AND conversation_id = ?').get(scope.branchId, conversationId!))) {
      throw new TurnRequestConflictError()
    }
    const conversation = JSON.stringify(currentConversation)
    const source = JSON.stringify(readSource())
    return () => (('draftId' in intent && this.#options.actorId && !this.#ownsDraft(intent.draftId)) || ('input' in intent && intent.input.legacyResourceDraftId && !this.#ownsDraft(intent.input.legacyResourceDraftId)))
      ? { errorCode: 'DRAFT_CONFLICT', target: {}, result: {} }
      : JSON.stringify(readConversation()) === conversation && JSON.stringify(readSource()) === source
        ? null
        : { errorCode: 'SOURCE_CHANGED', target: {}, result: {} }
  }

  #ownsDraft(draftId: string): boolean {
    return Boolean(this.#options.database.prepare('SELECT 1 FROM composer_drafts WHERE id = ? AND owner_actor_id = ?').get(draftId, this.#options.actorId!))
  }

  #validate(attachments: PreparedTurnAttachments, validateSource: () => CommandRejection | null): CommandRejection | null {
    const source = validateSource()
    if (source)
      return source
    try {
      attachments.validate()
      return null
    }
    catch (error) {
      if (isPreparedResourceResultUnknown(error))
        throw error
      return { errorCode: 'RESOURCE_UNAVAILABLE', target: {}, result: {} }
    }
  }

  #acceptedRun(accepted: { request: { runId: string }, decision: CommandDecision }) {
    return { decision: accepted.decision, dispatch: () => this.#options.turns.launchAccepted(accepted.request.runId) }
  }

  #dispatch(resourceCommit: Promise<void>, dispatch: () => void | Promise<void>): void {
    const dispatched = Promise.resolve().then(async () => {
      await resourceCommit
      await dispatch()
    }).catch(this.#options.onDispatchError).finally(() => this.#dispatches.delete(dispatched))
    this.#dispatches.add(dispatched)
  }
}

function rejectInputCommand(error: unknown): CommandRejection | null {
  if (error instanceof ComposerDraftCommitConflictError || error instanceof ComposerDraftConflictError
    || (error instanceof BuddyServiceError && error.code === 'DRAFT_CONFLICT')) {
    return { errorCode: 'DRAFT_CONFLICT', target: {}, result: {} }
  }
  if (error instanceof TurnRequestConflictError || error instanceof CommandRequestConflictError)
    return { errorCode: 'SOURCE_CHANGED', target: {}, result: {} }
  if (error instanceof BuddyServiceError && (error.code === 'INPUT_DELIVERY_INCOMPATIBLE' || error.code === 'INPUT_DELIVERY_TARGET_UNAVAILABLE'))
    return { errorCode: error.code, target: {}, result: {} }
  return null
}
