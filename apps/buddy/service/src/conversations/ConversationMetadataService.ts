import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { ConversationModelSelection, ConversationRecord } from '../storage/conversationRecord'
import type { ConversationRepository, RenameConversationInput, SetConversationPermissionSettingsInput } from '../storage/conversationRepository'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export type ConversationMetadataCommit = EventSnapshot<{
  commitId: string
  kind: 'title' | 'permissions' | 'model' | 'branch'
  conversation: ConversationRecord
  titleRevision?: number
  titleSource?: 'legacy' | 'manual' | 'fallback' | 'generated'
}>

export interface ConversationMetadataServiceOptions {
  repository: Pick<ConversationRepository, 'findById' | 'rename' | 'renameGenerated' | 'getTitleState' | 'setPermissionSettings' | 'setModelSelection' | 'activateBranch'>
  resolveModelSelection: (selection: ConversationModelSelection) => Promise<ConversationModelSelection>
  sessions: { invalidateConversation: (conversationId: string) => Promise<{ pending: number, degraded: number }> }
  onObserverError?: (error: unknown) => void
}

export class ConversationMetadataService {
  readonly #options: ConversationMetadataServiceOptions
  readonly #committed: Emitter<ConversationMetadataCommit>
  readonly #pendingPermissions = new Map<string, symbol>()
  readonly #pending = new Set<Promise<unknown>>()
  readonly onDidCommit: Emitter<ConversationMetadataCommit>['event']
  #disposed = false

  constructor(options: ConversationMetadataServiceOptions) {
    this.#options = options
    this.#committed = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidCommit = this.#committed.event
  }

  getTitleState(conversationId: string) {
    return this.#options.repository.getTitleState(conversationId)
  }

  rename(input: RenameConversationInput): ConversationRecord {
    this.#requireActive(input.id)
    const conversation = this.#options.repository.rename(input)
    this.#publish('title', conversation)
    return conversation
  }

  renameGenerated(input: RenameConversationInput & { expectedRevision: number, userInitiated?: boolean }): ConversationRecord | null {
    if (this.#disposed)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const conversation = this.#options.repository.renameGenerated(input)
    if (conversation)
      this.#publish('title', conversation)
    return conversation
  }

  setPermissionSettings(input: Omit<SetConversationPermissionSettingsInput, 'updatedAt'>): Promise<ConversationRecord> {
    return this.#run(() => this.#setPermissionSettings({ ...input }))
  }

  async #setPermissionSettings(input: Omit<SetConversationPermissionSettingsInput, 'updatedAt'>): Promise<ConversationRecord> {
    const { id, approvalPolicy, executionProfile } = input
    const current = this.#requireActive(id)
    if (current.approvalPolicy === approvalPolicy && current.executionProfile === executionProfile) {
      await this.#applyPermissions(id)
      return current
    }
    const conversation = this.#options.repository.setPermissionSettings({ id, approvalPolicy, executionProfile, updatedAt: new Date().toISOString() })
    if (!conversation)
      throw new BuddyServiceError('VALIDATION_FAILED')
    this.#pendingPermissions.set(id, Symbol('permission-invalidation'))
    this.#publish('permissions', conversation)
    await this.#applyPermissions(id)
    return conversation
  }

  setModelSelection(input: { id: string, modelSelection: ConversationModelSelection }): Promise<ConversationRecord> {
    return this.#run(() => this.#setModelSelection({ id: input.id, modelSelection: { ...input.modelSelection } }))
  }

  async #setModelSelection(input: { id: string, modelSelection: ConversationModelSelection }): Promise<ConversationRecord> {
    const id = input.id
    this.#requireActive(id)
    const resolved = await this.#options.resolveModelSelection({ ...input.modelSelection })
    const current = this.#requireActive(id)
    const selection: ConversationModelSelection = {
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      reasoning: resolved.reasoning,
      serviceTier: resolved.serviceTier,
    }
    if (sameSelection(current.modelSelection, selection))
      return current
    const conversation = this.#options.repository.setModelSelection({ id, modelSelection: selection, updatedAt: new Date().toISOString() })
    if (!conversation)
      throw new BuddyServiceError('VALIDATION_FAILED')
    this.#publish('model', conversation)
    return conversation
  }

  activateBranch(input: { conversationId: string, branchId: string }): ConversationRecord {
    const current = this.#requireActive(input.conversationId)
    if (current.activeBranchId === input.branchId)
      return current
    const conversation = this.#options.repository.activateBranch({ ...input, updatedAt: new Date().toISOString() })
    this.#publish('branch', conversation)
    return conversation
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await Promise.allSettled(this.#pending)
    this.#committed.dispose()
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#disposed)
      return Promise.reject(new BuddyServiceError('VALIDATION_FAILED'))
    const pending = Promise.withResolvers<T>()
    this.#pending.add(pending.promise)
    void operation().then((value) => {
      this.#pending.delete(pending.promise)
      pending.resolve(value)
    }, (error) => {
      this.#pending.delete(pending.promise)
      pending.reject(error)
    })
    return pending.promise
  }

  #requireActive(id: string): ConversationRecord {
    const conversation = this.#options.repository.findById(id)
    if (this.#disposed || !conversation || conversation.deletedAt !== null)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return conversation
  }

  async #applyPermissions(id: string): Promise<void> {
    const pending = this.#pendingPermissions.get(id)
    if (!pending)
      return
    const result = await this.#options.sessions.invalidateConversation(id)
    if (result.pending || result.degraded)
      throw new ConversationSettingsApplicationError(result.degraded ? 'CONVERSATION_SETTINGS_FAILED' : 'CONVERSATION_SETTINGS_PENDING')
    if (this.#pendingPermissions.get(id) === pending)
      this.#pendingPermissions.delete(id)
  }

  #publish(kind: ConversationMetadataCommit['kind'], conversation: ConversationRecord): void {
    const title = kind === 'title' ? this.#options.repository.getTitleState(conversation.id) : null
    this.#committed.fire(copyEventSnapshot({
      commitId: randomUUID(),
      kind,
      conversation,
      ...(title ? { titleRevision: title.revision, titleSource: title.source } : {}),
    }))
  }
}

class ConversationSettingsApplicationError extends Error {
  readonly code: 'CONVERSATION_SETTINGS_FAILED' | 'CONVERSATION_SETTINGS_PENDING'

  constructor(code: ConversationSettingsApplicationError['code']) {
    super('Lexora Buddy conversation settings are committed but session invalidation is incomplete')
    this.name = 'ConversationSettingsApplicationError'
    this.code = code
  }
}

function sameSelection(left: ConversationModelSelection | null, right: ConversationModelSelection): boolean {
  return left?.modelId === right.modelId && left.providerId === right.providerId
    && left.reasoning === right.reasoning && left.serviceTier === right.serviceTier
}
