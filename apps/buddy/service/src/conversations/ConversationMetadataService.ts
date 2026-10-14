import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { BuddiesService } from '../buddies/BuddiesService'
import type { ConversationModelSelection, ConversationRecord } from '../storage/conversationRecord'
import type { ConversationRepository, RenameConversationInput, SetConversationPermissionSettingsInput } from '../storage/conversationRepository'
import type { RunInputRepository } from '../storage/runInputRepository'
import type { RunRecord } from '../storage/runRecord'
import type { RunRepository } from '../storage/runRepository'
import type { SessionReferenceSettingsService } from './SessionReferenceSettingsService'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export type ConversationMetadataCommit = EventSnapshot<{
  commitId: string
  kind: 'title' | 'permissions' | 'model' | 'branch' | 'buddy' | 'references'
  conversation: ConversationRecord
  actorId?: string
  titleRevision?: number
  titleSource?: 'legacy' | 'manual' | 'fallback' | 'generated'
}>

export interface ConversationMetadataServiceOptions {
  references?: SessionReferenceSettingsService
  buddies?: Pick<BuddiesService, 'get'>
  runInputs?: Pick<RunInputRepository, 'findByRunId'>
  runs?: Pick<RunRepository, 'findById' | 'setModelSelection' | 'findActiveForConversation'>
  repository: Pick<ConversationRepository, 'findById' | 'rename' | 'renameGenerated' | 'getTitleState' | 'setPermissionSettings' | 'setModelSelection' | 'findMember' | 'listMembers' | 'addMember' | 'removeMember' | 'setBuddy' | 'activateBranch'>
  resolveModelSelection: (selection: ConversationModelSelection) => Promise<ConversationModelSelection>
  sessions: {
    invalidateConversation: (conversationId: string) => Promise<{ pending: number, degraded: number }>
    applyPermissionSettings?: (conversation: ConversationRecord) => Promise<{ pending: number, degraded: number }>
    refreshModelSelection?: (runId: string) => void
  }
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

  listReferenceAccess(input: { conversationId: string, branchId: string }) {
    if (!this.#options.references || this.#disposed)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return this.#options.references.list(input)
  }

  setReferenceExcluded(input: { conversationId: string, branchId: string, sessionId: string, excluded: boolean }) {
    if (!this.#options.references || this.#disposed)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const result = this.#options.references.setExcluded(input)
    this.#publish('references', this.#requireActive(input.conversationId))
    return result
  }

  listMembers(conversationId: string) {
    this.#requireActive(conversationId)
    return this.#options.repository.listMembers(conversationId).map(({ actorId, joinedAt }) => ({ actorId, joinedAt }))
  }

  addMember(input: { id: string, buddyId: string }) {
    this.#requireActive(input.id)
    this.#options.repository.addMember({ ...input, updatedAt: new Date().toISOString() })
    this.#publish('buddy', this.#requireActive(input.id))
    return this.listMembers(input.id)
  }

  removeMember(input: { id: string, buddyId: string }) {
    this.#requireActive(input.id)
    this.#options.repository.removeMember({ ...input, updatedAt: new Date().toISOString() })
    this.#publish('buddy', this.#requireActive(input.id))
    return this.listMembers(input.id)
  }

  setBuddy(input: { id: string, buddyId: string }): ConversationRecord {
    const current = this.#requireActive(input.id)
    const conversation = this.#options.repository.setBuddy({ ...input, updatedAt: new Date().toISOString() })
    if (!conversation)
      throw new BuddyServiceError('VALIDATION_FAILED')
    if (current.buddyId !== conversation.buddyId)
      this.#publish('buddy', conversation)
    return conversation
  }

  getModelControls(conversationId: string, actorId?: string) {
    const conversation = this.#requireActive(conversationId)
    const run = this.#options.runs?.findActiveForConversation(conversationId)
    const nextActorId = actorId ?? conversation.buddyId
    const buddy = this.#options.buddies?.get(nextActorId)
    if (buddy && (buddy.kind !== 'actor' || !buddy.enabled || buddy.deletedAt))
      throw new BuddyServiceError('BUDDY_NOT_ACTOR')
    const member = this.#options.repository.findMember(conversationId, nextActorId)
    return {
      current: run ? { runId: run.id, actorId: run.buddyId, modelSelection: this.#runModelSelection(run) } : null,
      next: { actorId: nextActorId, isMember: Boolean(member), modelSelection: member?.modelSelection ?? (nextActorId === conversation.buddyId ? conversation.modelSelection : null) ?? buddy?.settings.model ?? null },
    }
  }

  #runModelSelection(run: RunRecord): ConversationModelSelection {
    const stored = this.#options.runInputs?.findByRunId(run.id)
    return run.modelOverride ?? run.actorSnapshot?.model ?? { providerId: run.provider, modelId: run.model, reasoning: stored?.reasoning ?? null, serviceTier: stored?.serviceTier ?? null }
  }

  setModelSelection(input: { id: string, actorId?: string, runId?: string, modelSelection: ConversationModelSelection | null }): Promise<ConversationRecord> {
    return this.#run(() => this.#setModelSelection({
      id: input.id,
      actorId: input.actorId,
      runId: input.runId,
      modelSelection: input.modelSelection === null ? null : { ...input.modelSelection },
    }))
  }

  async #setModelSelection(input: { id: string, actorId?: string, runId?: string, modelSelection: ConversationModelSelection | null }): Promise<ConversationRecord> {
    const id = input.id
    const actorId = input.actorId ?? this.#targetRunActor(input.runId, id) ?? this.#requireActive(id).buddyId
    this.#targetRunActor(input.runId, id, actorId)
    this.#requireActive(id)
    if (!input.runId && !this.#options.repository.findMember(id, actorId))
      throw new BuddyServiceError('VALIDATION_FAILED')
    const resolved = input.modelSelection === null ? null : await this.#options.resolveModelSelection({ ...input.modelSelection })
    const current = this.#requireActive(id)
    const selection: ConversationModelSelection | null = resolved === null
      ? null
      : {
          providerId: resolved.providerId,
          modelId: resolved.modelId,
          reasoning: resolved.reasoning,
          serviceTier: resolved.serviceTier,
        }
    if (input.runId) {
      this.#targetRunActor(input.runId, id, actorId)
      if (!this.#options.runs?.setModelSelection(input.runId, selection))
        throw new BuddyServiceError('VALIDATION_FAILED')
      this.#publish('model', current, actorId)
      this.#options.sessions.refreshModelSelection?.(input.runId)
      return current
    }
    const member = this.#options.repository.findMember(id, actorId)
    if (!member)
      throw new BuddyServiceError('VALIDATION_FAILED')
    this.#targetRunActor(input.runId, id, actorId)
    if (sameSelection(member.modelSelection, selection)
      && (selection === null || member.modelSelectionSource === 'explicit')) {
      if (this.#refreshActorModel(id, actorId, selection))
        this.#publish('model', current, actorId)
      return current
    }
    const conversation = this.#options.repository.setModelSelection({ id, actorId, modelSelection: selection, updatedAt: new Date().toISOString() })
    if (!conversation)
      throw new BuddyServiceError('VALIDATION_FAILED')
    this.#refreshActorModel(id, actorId, selection)
    this.#publish('model', conversation, actorId)
    return conversation
  }

  #refreshActorModel(conversationId: string, actorId: string, selection: ConversationModelSelection | null): boolean {
    const run = this.#options.runs?.findActiveForConversation(conversationId)
    if (!run || run.buddyId !== actorId || sameSelection(this.#runModelSelection(run), selection))
      return false
    if (!this.#options.runs?.setModelSelection(run.id, selection))
      return false
    this.#options.sessions.refreshModelSelection?.(run.id)
    return true
  }

  #targetRunActor(runId: string | undefined, conversationId: string, actorId?: string): string | undefined {
    if (!runId)
      return undefined
    const run = this.#options.runs?.findById(runId)
    if (!run || run.conversationId !== conversationId || !['queued', 'running'].includes(run.status) || (actorId && actorId !== run.buddyId))
      throw new BuddyServiceError('VALIDATION_FAILED')
    return run.buddyId
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
    const result = this.#options.sessions.applyPermissionSettings
      ? await this.#options.sessions.applyPermissionSettings(this.#requireActive(id))
      : await this.#options.sessions.invalidateConversation(id)
    if (result.pending || result.degraded)
      throw new ConversationSettingsApplicationError(result.degraded ? 'CONVERSATION_SETTINGS_FAILED' : 'CONVERSATION_SETTINGS_PENDING')
    if (this.#pendingPermissions.get(id) === pending)
      this.#pendingPermissions.delete(id)
  }

  #publish(kind: ConversationMetadataCommit['kind'], conversation: ConversationRecord, actorId?: string): void {
    const title = kind === 'title' ? this.#options.repository.getTitleState(conversation.id) : null
    this.#committed.fire(copyEventSnapshot({
      commitId: randomUUID(),
      kind,
      conversation,
      ...(actorId ? { actorId } : {}),
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

function sameSelection(left: ConversationModelSelection | null, right: ConversationModelSelection | null): boolean {
  if (left === null || right === null)
    return left === right
  return left?.modelId === right.modelId && left.providerId === right.providerId
    && left.reasoning === right.reasoning && left.serviceTier === right.serviceTier
}
