import type { DatabaseSync } from 'node:sqlite'
import type { ConversationArchivePage, ConversationArchivePolicy, ConversationArchiveQuery } from '../../../shared/conversation/conversationArchiveApi'
import type { CommandAdmissionService, CommandResolution } from '../commands/CommandAdmissionService'
import type { InputCommandIntent } from '../commands/commandIntent'
import type { CommandDecision, CommandRejection } from '../storage/CommandCommitter'
import type { ConversationCommandRepository } from '../storage/ConversationCommandRepository'
import type { ConversationDeletionCommit } from '../storage/conversationDeletionRepository'
import type { ConversationLifecycleService } from './ConversationLifecycleService'
import type { ConversationMetadataService } from './ConversationMetadataService'
import type { TaskMarkService } from './TaskMarkService'
import { ProductCommandRequiredError } from '../rpc/candidateLegacyRegistrar'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { ChatControlConflictError } from '../storage/ChatControlCommandRepository'
import { afterTransactionCommit, assertCommittedRead } from '../storage/transaction'
import { ConversationArchiveConflictError } from './ConversationArchiveService'
import { ConversationLifecycleError } from './ConversationLifecycleService'

export type ConversationCommandMethod
  = | 'conversations.rename' | 'conversations.delete' | 'conversations.activateBranch'
    | 'conversations.archive' | 'conversations.restoreArchive' | 'conversations.deleteArchived' | 'conversations.deleteLegacyRemoved' | 'conversations.setArchivePolicy'
    | 'conversations.setPermissionSettings' | 'conversations.setModelSelection' | 'conversations.setBuddy'
    | 'conversations.addMember' | 'conversations.removeMember' | 'conversations.moveToSpace'
    | 'taskMarks.create' | 'taskMarks.update' | 'taskMarks.delete' | 'taskMarks.assign' | 'taskMarks.setRead' | 'taskMarks.clear'

type MetadataCommands = Pick<ConversationMetadataService, 'withMutationScope' | 'rename' | 'activateBranch' | 'commitPermissionSettings' | 'prepareModelSelection' | 'commitModelSelection'
  | 'addMember' | 'removeMember' | 'setBuddy' | 'prepareSpaceMove' | 'commitSpaceMove'>

export interface ConversationArchiveCommands {
  withMutationScope: <T>(id: string, operation: () => Promise<T>) => Promise<T>
  prepareArchive: (id: string, expectedRevision?: number) => Promise<void>
  commitArchive: (id: string, expectedRevision?: number) => boolean
  commitRestore: (id: string, expectedRevision?: number) => boolean
  commitDelete: (id: string, expectedRevision?: number) => ConversationDeletionCommit
  commitDeleteLegacyRemoved: (id: string, expectedRevision?: number) => ConversationDeletionCommit
  finishDeletion: (commit: ConversationDeletionCommit) => Promise<boolean>
  list: (input: ConversationArchiveQuery) => ConversationArchivePage
  getPolicy: () => ConversationArchivePolicy
  setPolicy: (days: ConversationArchivePolicy['days']) => ConversationArchivePolicy
}

interface ConversationCommandServiceOptions {
  database: DatabaseSync
  admission: Pick<CommandAdmissionService, 'execute'>
  repository: ConversationCommandRepository
  archive?: ConversationArchiveCommands
  metadata: MetadataCommands
  lifecycle: Pick<ConversationLifecycleService, 'commitDelete' | 'finishDeletion'>
  marks: Pick<TaskMarkService, 'create' | 'update' | 'delete' | 'assign' | 'setRead' | 'clear'>
  onEffectError: (error: unknown) => void
}

interface PreparedMetadataCommand {
  commit: () => CommandDecision
}

export class ConversationCommandService {
  readonly #options: ConversationCommandServiceOptions
  readonly #effects = new Set<Promise<void>>()

  constructor(options: ConversationCommandServiceOptions) {
    this.#options = options
  }

  execute(method: ConversationCommandMethod, input: unknown): Promise<CommandResolution> {
    return this.#options.admission.execute(method, input, {
      scope: (intent, operation) => {
        if (method === 'conversations.archive' && 'conversationId' in intent)
          return this.#archive().withMutationScope(intent.conversationId, operation)
        if (method === 'conversations.moveToSpace' && 'conversationId' in intent)
          return this.#options.metadata.withMutationScope(intent.conversationId, operation)
        return operation()
      },
      prepare: async (intent, signal) => {
        signal.throwIfAborted()
        const prepared = await this.#prepare(method, intent)
        signal.throwIfAborted()
        return prepared
      },
      reject: rejectMetadata,
      commit: prepared => prepared.commit(),
    })
  }

  listArchived(input: ConversationArchiveQuery): ConversationArchivePage {
    assertCommittedRead(this.#options.database)
    return this.#archive().list(input)
  }

  getArchivePolicy(): ConversationArchivePolicy {
    assertCommittedRead(this.#options.database)
    return this.#archive().getPolicy()
  }

  #archive(): ConversationArchiveCommands {
    if (!this.#options.archive)
      throw new ProductCommandRequiredError()
    return this.#options.archive
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.#effects)
  }

  async #prepare(method: ConversationCommandMethod, intent: Readonly<InputCommandIntent<ConversationCommandMethod>>): Promise<PreparedMetadataCommand> {
    const { repository, metadata, marks, lifecycle } = this.#options
    switch (method) {
      case 'conversations.archive': {
        const input = intent as InputCommandIntent<typeof method>
        const archive = this.#archive()
        await archive.prepareArchive(input.conversationId, input.expectedRevision)
        return { commit: () => ({ target: { conversationId: input.conversationId }, result: { archived: archive.commitArchive(input.conversationId, input.expectedRevision) } }) }
      }
      case 'conversations.restoreArchive': {
        const input = intent as InputCommandIntent<typeof method>
        return { commit: () => ({ target: { conversationId: input.conversationId }, result: { restored: this.#archive().commitRestore(input.conversationId, input.expectedRevision) } }) }
      }
      case 'conversations.deleteArchived':
      case 'conversations.deleteLegacyRemoved': {
        const input = intent as InputCommandIntent<'conversations.deleteArchived' | 'conversations.deleteLegacyRemoved'>
        return { commit: () => {
          const archive = this.#archive()
          const committed = method === 'conversations.deleteLegacyRemoved'
            ? archive.commitDeleteLegacyRemoved(input.conversationId, input.expectedRevision)
            : archive.commitDelete(input.conversationId, input.expectedRevision)
          this.#afterCommit(() => archive.finishDeletion(committed))
          return { target: { conversationId: input.conversationId }, result: { deleted: true, deletedAt: committed.deletedAt, cleanup: 'pending' } }
        } }
      }
      case 'conversations.setArchivePolicy': {
        const input = intent as InputCommandIntent<typeof method>
        return { commit: () => ({ target: {}, result: { archivePolicy: { ...this.#archive().setPolicy(input.days) } } }) }
      }
      case 'conversations.rename': {
        const input = intent as InputCommandIntent<typeof method>
        return { commit: () => {
          repository.assertConversation(input.conversationId, input.expectedTitleRevision, true)
          metadata.rename({ id: input.conversationId, title: input.title })
          return { target: { conversationId: input.conversationId }, result: { titleRevision: repository.conversationRevision(input.conversationId, true) } }
        } }
      }
      case 'conversations.delete': {
        const input = intent as InputCommandIntent<typeof method>
        return { commit: () => {
          repository.assertConversation(input.conversationId, input.expectedRevision)
          const committed = lifecycle.commitDelete(input.conversationId)
          this.#afterCommit(() => lifecycle.finishDeletion(committed))
          return { target: { conversationId: input.conversationId }, result: { deletedAt: committed.deletedAt, cleanup: 'pending' } }
        } }
      }
      case 'conversations.setModelSelection': {
        const input = intent as InputCommandIntent<typeof method>
        repository.assertConversation(input.conversationId, input.expectedRevision)
        const assertRun = () => {
          if (input.targetRunId)
            repository.assertRunModel({ ...input, targetRunId: input.targetRunId, expectedRunGeneration: input.expectedRunGeneration!, expectedRunModelSelection: input.expectedRunModelSelection! })
        }
        assertRun()
        const prepared = await metadata.prepareModelSelection({ id: input.conversationId, actorId: input.actorId, runId: input.targetRunId, modelSelection: input.modelSelection })
        return { commit: () => {
          repository.assertConversation(input.conversationId, input.expectedRevision)
          assertRun()
          if (!input.targetRunId)
            repository.assertActiveRunModel({ conversationId: input.conversationId, actorId: prepared.actorId, expectedActiveRun: input.expectedActiveRun! })
          metadata.commitModelSelection(prepared)
          return { target: { conversationId: input.conversationId, actorId: prepared.actorId, ...(input.targetRunId ? { runId: input.targetRunId } : {}) }, result: { revision: repository.conversationRevision(input.conversationId), modelSelection: prepared.selection ? { ...prepared.selection } : null } }
        } }
      }
      case 'conversations.moveToSpace': {
        const input = intent as InputCommandIntent<typeof method>
        repository.assertConversation(input.conversationId, input.expectedRevision)
        const prepared = await metadata.prepareSpaceMove({ id: input.conversationId, spaceId: input.spaceId })
        return { commit: () => {
          repository.assertConversation(input.conversationId, input.expectedRevision)
          metadata.commitSpaceMove(prepared)
          return { target: { conversationId: input.conversationId }, result: { revision: repository.conversationRevision(input.conversationId) } }
        } }
      }
      case 'conversations.activateBranch':
      case 'conversations.setPermissionSettings':
      case 'conversations.setBuddy':
      case 'conversations.addMember':
      case 'conversations.removeMember': {
        const input = intent as InputCommandIntent<'conversations.activateBranch' | 'conversations.setPermissionSettings' | 'conversations.setBuddy' | 'conversations.addMember' | 'conversations.removeMember'>
        return { commit: () => {
          repository.assertConversation(input.conversationId, input.expectedRevision)
          if ('branchId' in input)
            metadata.activateBranch(input)
          else if ('approvalPolicy' in input)
            metadata.commitPermissionSettings({ ...input, id: input.conversationId })
          else if (method === 'conversations.addMember')
            metadata.addMember({ id: input.conversationId, buddyId: input.buddyId })
          else if (method === 'conversations.removeMember')
            metadata.removeMember({ id: input.conversationId, buddyId: input.buddyId })
          else
            metadata.setBuddy({ id: input.conversationId, buddyId: input.buddyId })
          return { target: { conversationId: input.conversationId, ...('branchId' in input ? { branchId: input.branchId } : {}) }, result: { revision: repository.conversationRevision(input.conversationId) } }
        } }
      }
      case 'taskMarks.create': {
        const input = intent as InputCommandIntent<typeof method>
        return { commit: () => {
          const mark = marks.create(input)
          return { target: { markId: mark.id }, result: { revision: repository.markRevision(mark.id) } }
        } }
      }
      case 'taskMarks.update': {
        const input = intent as InputCommandIntent<typeof method>
        return { commit: () => {
          repository.assertMark(input.id, input.expectedRevision)
          marks.update(input.id, input)
          return { target: { markId: input.id }, result: { revision: repository.markRevision(input.id) } }
        } }
      }
      case 'taskMarks.delete': {
        const input = intent as InputCommandIntent<typeof method>
        return { commit: () => {
          repository.assertMark(input.id, input.expectedRevision)
          marks.delete(input.id)
          return { target: { markId: input.id }, result: { deleted: true } }
        } }
      }
      case 'taskMarks.assign': {
        const input = intent as InputCommandIntent<typeof method>
        return { commit: () => {
          repository.assertAssignment(input.conversationId, input.expectedAssignmentRevision)
          if (input.markId)
            repository.markRevision(input.markId)
          marks.assign(input.conversationId, input.markId)
          return { target: { conversationId: input.conversationId }, result: { assignmentRevision: repository.assignmentRevision(input.conversationId) } }
        } }
      }
      case 'taskMarks.setRead':
      case 'taskMarks.clear': {
        const input = intent as InputCommandIntent<'taskMarks.setRead' | 'taskMarks.clear'>
        return { commit: () => {
          repository.assertRead(input)
          if ('expectedAssignmentRevision' in input)
            repository.assertAssignment(input.conversationId, input.expectedAssignmentRevision)
          const state = 'read' in input ? marks.setRead(input) : marks.clear(input)
          return { target: { conversationId: input.conversationId }, result: { readRevision: state.readRevision, assignmentRevision: repository.assignmentRevision(input.conversationId), resultRunId: state.resultRunId } }
        } }
      }
    }
  }

  #afterCommit(effect: () => unknown | Promise<unknown>): void {
    afterTransactionCommit(this.#options.database, () => {
      const pending = Promise.resolve().then(effect).then(() => {}, this.#options.onEffectError).finally(() => this.#effects.delete(pending))
      this.#effects.add(pending)
    }, this.#options.onEffectError)
  }
}

function rejectMetadata(error: unknown): CommandRejection | null {
  if (error instanceof ChatControlConflictError || error instanceof ConversationArchiveConflictError)
    return { errorCode: error.code, target: {}, result: {} }
  if ((error instanceof Error && error.name === 'ConversationRepositoryError') || error instanceof BuddyServiceError || error instanceof ConversationLifecycleError)
    return { errorCode: 'SOURCE_CHANGED', target: {}, result: {} }
  return null
}
