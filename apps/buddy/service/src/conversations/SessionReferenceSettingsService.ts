import type { ConversationRepository } from '../storage/conversationRepository'
import type { SessionReferenceRepository } from '../storage/sessionReferenceRepository'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { SessionReferenceAccessResolver } from './SessionReferenceAccess'

export class SessionReferenceSettingsService {
  readonly conversations: Pick<ConversationRepository, 'findById'>
  readonly repository: SessionReferenceRepository

  constructor(conversations: Pick<ConversationRepository, 'findById'>, repository: SessionReferenceRepository) {
    this.conversations = conversations
    this.repository = repository
  }

  list(input: { conversationId: string, branchId: string }) {
    this.#requireScope(input)
    return new SessionReferenceAccessResolver(this.conversations, this.repository).resolve({ ...input, throughSequence: this.repository.headSequence(input.conversationId) })
  }

  setExcluded(input: { conversationId: string, branchId: string, sessionId: string, excluded: boolean }) {
    const access = this.list(input)
    if (!access.references.some(reference => reference.id === input.sessionId))
      throw new BuddyServiceError('VALIDATION_FAILED')
    this.repository.setExcluded(input, input.sessionId, input.excluded)
    return this.list(input)
  }

  #requireScope(input: { conversationId: string, branchId: string }): void {
    const conversation = this.conversations.findById(input.conversationId)
    if (!conversation || conversation.deletedAt || conversation.activeBranchId !== input.branchId)
      throw new BuddyServiceError('VALIDATION_FAILED')
  }
}
