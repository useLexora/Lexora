import type { DatabaseSync } from 'node:sqlite'
import type { ApprovalService } from '../approvals/ApprovalService'
import type { TrustedCommandPrincipal } from '../commands/CommandAdmissionService'
import type { RemoteUploadService } from '../privateNetwork/RemoteUploadService'
import type { UserQuestionService } from '../questions/UserQuestionService'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { ChatControlCommandService } from '../chat/ChatControlCommandService'
import { ChatInputCommandService } from '../chat/ChatInputCommandService'
import { ComposerDraftCommandService } from '../chat/ComposerDraftCommandService'
import { PreparedRunCommandService } from '../chat/PreparedRunCommandService'
import { CommandAdmissionService } from '../commands/CommandAdmissionService'
import { DesktopOpenCommandService } from '../commands/DesktopOpenCommandService'
import { ConversationCommandService } from '../conversations/ConversationCommandService'
import { ConversationCommandRepository } from '../storage/ConversationCommandRepository'

export interface ProductActorCommands {
  identity: { dataGeneration: string, serviceInstanceId: string }
  admission: CommandAdmissionService
  desktop: DesktopOpenCommandService
  input: ChatInputCommandService
  drafts: ComposerDraftCommandService
  control: ChatControlCommandService
  metadata: ConversationCommandService
  uploads: ReturnType<RemoteUploadService['commands']>
  approvals: Pick<ApprovalService, 'resolveCommand' | 'getReview'>
  questions: { execute: (method: 'questions.answer' | 'questions.cancel' | 'questions.retry', input: unknown) => ReturnType<UserQuestionService['executeCommand']> }
}

type InputOptions = ConstructorParameters<typeof ChatInputCommandService>[0]
type DraftOptions = ConstructorParameters<typeof ComposerDraftCommandService>[0]
type ControlOptions = ConstructorParameters<typeof ChatControlCommandService>[0]
type ConversationOptions = ConstructorParameters<typeof ConversationCommandService>[0]

interface ProductActorCommandDependencies {
  runs: Required<Pick<ConstructorParameters<typeof PreparedRunCommandService>[0], 'turns' | 'events'>>
  input: Pick<InputOptions, 'turns' | 'compact' | 'queue' | 'assertExecutionAvailable'>
  drafts: Pick<DraftOptions, 'prepareAttachments' | 'releaseResources'> & { access: DraftOptions['drafts'] & InputOptions['drafts'] }
  conversations: Pick<ConversationOptions, 'metadata' | 'lifecycle' | 'archive' | 'marks'>
  control: Pick<ControlOptions, 'repository' | 'queue'> & { stopExecution: () => Promise<void> }
  uploads: Pick<RemoteUploadService, 'commands' | 'commitInput'>
  questions: Pick<UserQuestionService, 'executeCommand'>
  approvals: Pick<ApprovalService, 'getReview' | 'resolveCommand'>
  openDesktop: ConstructorParameters<typeof DesktopOpenCommandService>[0]['openDesktop']
  onError: (error: unknown) => void
}

export class ProductActorCommandScope {
  readonly admission: CommandAdmissionService
  readonly #database: DatabaseSync
  readonly #principal: TrustedCommandPrincipal
  readonly #identity: ProductActorCommands['identity']
  #commands: ProductActorCommands | undefined
  #preparedRuns: PreparedRunCommandService | undefined
  #disposed: Promise<void> | undefined

  constructor(database: DatabaseSync, principal: TrustedCommandPrincipal, identity: ProductActorCommands['identity']) {
    this.#database = database
    this.#principal = principal
    this.#identity = identity
    this.admission = new CommandAdmissionService({ database, principal, sourceInstanceId: identity.serviceInstanceId })
  }

  get hasPendingOperations(): boolean {
    return this.admission.hasPendingOperations
  }

  initialize(dependencies: ProductActorCommandDependencies): ProductActorCommands {
    if (this.#disposed)
      throw new ProductProtocolError('SERVICE_NOT_READY')
    if (this.#commands)
      return this.#commands
    const database = this.#database
    const principal = this.#principal
    const admission = this.admission
    const onError = dependencies.onError
    const preparedRuns = this.#preparedRuns = new PreparedRunCommandService({ database, sourceInstanceId: this.#identity.serviceInstanceId, ...dependencies.runs, onObserverError: onError })
    const drafts = new ComposerDraftCommandService({ database, actorId: principal.actorId, admission, drafts: dependencies.drafts.access, prepareAttachments: dependencies.drafts.prepareAttachments, releaseResources: dependencies.drafts.releaseResources, onCleanupError: onError })
    const input = new ChatInputCommandService({ database, actorId: principal.actorId, admission, drafts: dependencies.drafts.access, ...dependencies.input, preparedRuns, commitSubmittedInput: input => dependencies.uploads.commitInput(principal, input), onDispatchError: onError })
    const metadata = new ConversationCommandService({ database, admission, repository: new ConversationCommandRepository(database), ...dependencies.conversations, onEffectError: onError })
    const control = new ChatControlCommandService({ database, admission, repository: dependencies.control.repository, queue: dependencies.control.queue, onDispatchError: onError, onServiceStop: async () => {
      this.stopAccepting()
      await dependencies.control.stopExecution()
    } })
    this.#commands = {
      identity: this.#identity,
      admission,
      desktop: new DesktopOpenCommandService({ database, admission, openDesktop: dependencies.openDesktop }),
      input,
      drafts,
      control,
      metadata,
      uploads: dependencies.uploads.commands(principal, admission),
      questions: { execute: (method, input) => dependencies.questions.executeCommand(method, input, admission) },
      approvals: { getReview: id => dependencies.approvals.getReview(id), resolveCommand: value => dependencies.approvals.resolveCommand(value, admission) },
    }
    return this.#commands
  }

  stopAccepting(): void {
    this.admission.stopAccepting()
  }

  dispose(): Promise<void> {
    return this.#disposed ??= this.#dispose()
  }

  async #dispose(): Promise<void> {
    this.stopAccepting()
    await this.admission.dispose()
    if (this.#commands) {
      const { input, control, drafts, metadata } = this.#commands
      await Promise.all([input.waitForDispatches(), control.waitForEffects(), drafts.dispose(), metadata.dispose()])
    }
    this.#preparedRuns?.dispose()
  }
}
