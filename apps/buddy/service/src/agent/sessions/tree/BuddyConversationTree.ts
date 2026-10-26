import type { Api, Model } from '@earendil-works/pi-ai'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { ConversationHistoryRepository } from '../../../storage/conversationHistoryRepository'
import type { ConversationTreeRepository } from '../../../storage/conversationTreeRepository'
import type { RunRecord } from '../../../storage/runRecord'
import type { RunRepository } from '../../../storage/runRepository'
import type { ThreadBindingRepository } from '../../../storage/threadBindingRepository'
import type { BuddySessionRecoveryService } from '../recovery/BuddySessionRecoveryService'
import type { BuddyTreeJournal } from './BuddyTreeStore'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { publicConversationMaterialSchema } from '../../../conversations/publicConversationContext'
import { BuddyAgentRunError } from '../../../runs/runError'
import { readBuddyInputReference } from '../../context/BuddyInputReference'
import { appendPublicPreview, PUBLIC_CONTEXT_TYPE, synchronizePublicContext } from './BuddyPublicContext'
import { BuddyTreeRecovery, findLegacyRunBoundary } from './BuddyTreeRecovery'
import { BuddyTreeStore, readCheckpoint } from './BuddyTreeStore'

export interface BuddyConversationTreeOptions {
  conversationsDirectory: string
  conversations: Pick<ConversationHistoryRepository, 'listBranchMessages'>
  repository: ConversationTreeRepository
  threads: Pick<ThreadBindingRepository, 'find' | 'findBinding' | 'bind'>
  runs: Pick<RunRepository, 'findById'>
  isRunHistoryAvailable?: (runId: string) => boolean
  recovery: Pick<BuddySessionRecoveryService, 'create'>
  onObserverError?: (error: unknown) => void
}

export class BuddyConversationTree {
  readonly #store: BuddyTreeStore
  readonly #options: BuddyConversationTreeOptions
  readonly #pending = new Set<Promise<unknown>>()
  readonly #openings = new Map<string, Promise<unknown>>()
  #stopping = false
  #closing: Promise<void> | undefined
  readonly onDidCommit: BuddyTreeStore['onDidCommit']
  readonly onDidFail: BuddyTreeStore['onDidFail']

  constructor(options: BuddyConversationTreeOptions) {
    this.#options = options
    this.#store = new BuddyTreeStore(options)
    this.onDidCommit = this.#store.onDidCommit
    this.onDidFail = this.#store.onDidFail
  }

  open(run: RunRecord, cwd: string, model: Model<Api>) {
    const captured = { ...run }
    const key = run.threadId
    const previous = this.#openings.get(key) ?? Promise.resolve()
    const result = this.#run(() => previous.catch(() => {}).then(() => this.#open(captured, cwd, model)))
    this.#openings.set(key, result)
    void result.finally(() => {
      if (this.#openings.get(key) === result)
        this.#openings.delete(key)
    }).catch(() => {})
    return result
  }

  async #open(run: RunRecord, cwd: string, model: Model<Api>) {
    const journal = await this.#store.open(run.conversationId, cwd, run.threadId)
    const cursor = new BuddyConversationTreeCursor(this.#options, journal, model)
    cursor.manager.branch(await cursor.resolveStart(run))
    return cursor
  }

  preview(conversationId: string, branchId: string, cwd: string, threadId: string) {
    return this.snapshot(conversationId, branchId, cwd, undefined, 'after', threadId)
  }

  snapshot(conversationId: string, branchId: string, cwd: string, sourceRunId: string | undefined, position: 'before' | 'after', threadId: string, publicMessageId?: string): Promise<SessionManager> {
    return this.#run(() => this.#snapshot(conversationId, branchId, cwd, sourceRunId, position, threadId, publicMessageId))
  }

  async #snapshot(conversationId: string, branchId: string, cwd: string, sourceRunId: string | undefined, position: 'before' | 'after', threadId: string, publicMessageId?: string): Promise<SessionManager> {
    const publications = new Map<string, ReturnType<ConversationTreeRepository['listPublications']>>()
    const repository = this.#options.repository
    const options = {
      ...this.#options,
      repository: {
        ...repository,
        listPublications: (conversationId: string, branchId: string, throughSequence = repository.getPublicSequence(conversationId)) => {
          const key = JSON.stringify([conversationId, branchId, throughSequence])
          let materials = publications.get(key)
          if (!materials) {
            materials = repository.listPublications(conversationId, branchId, throughSequence)
            publications.set(key, materials)
          }
          return materials
        },
      },
    }
    const source = sourceRunId ? options.runs.findById(sourceRunId) : null
    if (source && source.conversationId !== conversationId)
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    const targetThread = threadId
    const identity = options.threads.find(targetThread)
    if (identity && (identity.conversationId !== conversationId || identity.kind !== 'actor'))
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    const journal = identity ? await this.#store.read(conversationId, cwd, targetThread) : null
    let manager = journal?.manager ?? SessionManager.inMemory(cwd)
    const throughSequence = publicMessageId ? options.repository.getMessagePublicSequence(conversationId, publicMessageId) - (position === 'before' ? 1 : 0) : source ? options.repository.getRunPublicBoundary(source.id, position) : options.repository.getPublicSequence(conversationId)
    const materials = options.repository.listPublications(conversationId, branchId, throughSequence)
    const eligible = eligiblePublicRuns(options, conversationId, branchId, targetThread, throughSequence)
    const candidates = source?.threadId === targetThread && options.isRunHistoryAvailable?.(source.id) !== false
      ? [{ run: source, position }, ...eligible.map(run => ({ run, position: 'after' as const }))]
      : eligible.map(run => ({ run, position: 'after' as const }))
    const checkpoint = journal
      ? candidates.flatMap(candidate => manager.getEntries().filter((entry) => {
          const checkpoint = readCheckpoint(entry)
          return checkpoint?.runId === candidate.run.id && checkpoint.position === candidate.position
        })).find(entry => isPublicCheckpoint(manager, entry.id, materials, options))
      : undefined
    if (journal) {
      const target = checkpoint?.id ?? journal.rootId
      journal.validateAncestry(target)
      manager.branch(target)
    }
    else {
      for (const candidate of candidates) {
        const legacy = await this.#store.readLegacy(conversationId, cwd, candidate.run.piSessionFile, targetThread)
        if (!legacy)
          continue
        const boundary = findLegacyRunBoundary(legacy.manager, candidate.run, candidate.position)
        if (!boundary)
          continue
        if (boundary.entryId) {
          legacy.manager.branch(boundary.entryId)
          if (!isPublicCheckpoint(legacy.manager, boundary.entryId, materials, options))
            continue
        }
        else {
          legacy.manager.resetLeaf()
        }
        manager = legacy.manager
        break
      }
    }
    appendPublicPreview(manager, options.repository, { conversationId, branchId, threadId: targetThread, throughSequence })
    return manager
  }

  dispose(): Promise<void> {
    this.#stopping = true
    this.#closing ??= Promise.allSettled([...this.#pending]).then(() => this.#store.dispose())
    return this.#closing
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#stopping)
      return Promise.reject(new Error('Conversation tree is stopped'))
    const accepted = Promise.withResolvers<T>()
    this.#pending.add(accepted.promise)
    void accepted.promise.finally(() => this.#pending.delete(accepted.promise)).catch(() => {})
    void operation().then(accepted.resolve, accepted.reject)
    return accepted.promise
  }
}

export class BuddyConversationTreeCursor {
  readonly #resolving = new Set<string>()
  #activeRun: RunRecord | null = null
  readonly #recovery: BuddyTreeRecovery

  readonly #options: BuddyConversationTreeOptions
  readonly #journal: BuddyTreeJournal

  constructor(options: BuddyConversationTreeOptions, journal: BuddyTreeJournal, model: Model<Api>) {
    this.#options = options
    this.#journal = journal
    this.#recovery = new BuddyTreeRecovery(journal, model, options)
  }

  get manager() { return this.#journal.manager }
  get rootId() { return this.#journal.rootId }
  get recoveredFromProductHistory() { return this.#recovery.recoveredFromProductHistory }
  get recoveryDegradation() { return this.#recovery.recoveryDegradation }

  async begin(session: AgentSession, runId: string) {
    const run = this.#options.runs.findById(runId)
    if (!run)
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    const target = await this.resolveStart(run)
    this.#journal.validateAncestry(target)
    const result = await session.navigateTree(target, { summarize: false })
    if (result.cancelled || result.aborted || this.manager.getLeafId() !== target)
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    {
      const work = this.#options.repository.findWork(run.id)
      await synchronizePublicContext(session, this.#options.repository, {
        conversationId: run.conversationId,
        threadId: run.threadId,
        branchId: run.branchId,
        throughSequence: this.#options.repository.getPublicSnapshot(run.id),
        ...(work?.contextMode === 'isolated' ? { sourceIds: work.contextSourceIds } : {}),
        ...(run.purpose !== 'conversation.compaction' ? { skipMessageId: run.triggeringMessageId } : {}),
      })
    }
    this.#activeRun = run
    this.manager.branch(this.#journal.appendCheckpoint(run, 'before'))
  }

  finish() {
    const run = this.#activeRun
    if (!run)
      return
    this.manager.branch(this.#journal.appendCheckpoint(run, 'after'))
    this.#activeRun = null
  }

  async resolveStart(run: RunRecord): Promise<string> {
    this.#journal.assertRun(run)
    const work = this.#options.repository.findWork(run.id)
    if (work?.contextMode === 'isolated' || run.executionKind === 'npc_child') {
      if (!work?.previousRunId)
        return this.rootId
      const previous = this.#options.runs.findById(work.previousRunId)
      if (!previous || previous.threadId !== run.threadId || previous.branchId !== run.branchId
        || this.#options.isRunHistoryAvailable?.(previous.id) === false) {
        throw new BuddyAgentRunError('SESSION_STORAGE_UNAVAILABLE')
      }
      return this.#checkpoint(previous.id, 'after')
    }
    const explicit = this.#options.repository.findSource(run.id)
    const throughSequence = this.#options.repository.getPublicSnapshot(run.id)
    const materials = this.#options.repository.listPublications(run.conversationId, run.branchId, throughSequence)
    const eligible = eligiblePublicRuns(this.#options, run.conversationId, run.branchId, run.threadId, throughSequence).filter(candidate => candidate.id !== run.id)
    const source = explicit ? this.#options.runs.findById(explicit.sourceRunId) : null
    const candidates = source?.threadId === run.threadId && this.#options.isRunHistoryAvailable?.(source.id) !== false
      ? [{ run: source, position: explicit!.position }, ...eligible.map(run => ({ run, position: 'after' as const }))]
      : eligible.map(run => ({ run, position: 'after' as const }))
    for (const candidate of candidates) {
      if (candidate.run.piSessionFile === this.manager.getSessionFile() && !this.#journal.findCheckpoint(candidate.run.id, 'before') && !this.#journal.findCheckpoint(candidate.run.id, 'after'))
        continue
      const checkpoint = await this.#checkpoint(candidate.run.id, candidate.position)
      if (isPublicCheckpoint(this.manager, checkpoint, materials, this.#options))
        return checkpoint
    }
    return this.rootId
  }

  async #checkpoint(runId: string, position: 'before' | 'after'): Promise<string> {
    const key = `${runId}:${position}`
    const run = this.#options.runs.findById(runId)
    if (!run || this.#resolving.has(key))
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    this.#journal.assertRun(run)
    const existing = this.#journal.findCheckpoint(runId, position)
    if (existing) {
      return existing
    }
    this.#resolving.add(key)
    try {
      if (run.piSessionFile === this.manager.getSessionFile()) {
        if (position === 'before')
          return this.resolveStart(run)
        const before = this.#journal.findCheckpoint(run.id, 'before')
        if (before && run.status !== 'queued' && run.status !== 'running') {
          let endpoint = before
          const entries = this.manager.getEntries()
          for (const entry of entries.slice(entries.findIndex(entry => entry.id === before) + 1)) {
            if (readCheckpoint(entry))
              break
            if (entry.parentId === endpoint)
              endpoint = entry.id
          }
          return this.#journal.appendCheckpoint(run, position, endpoint, { source: 'native_endpoint' })
        }
        throw new BuddyAgentRunError('SESSION_STORAGE_UNAVAILABLE')
      }
      return await this.#recovery.restore(run, position)
    }
    finally {
      this.#resolving.delete(key)
    }
  }
}

function eligiblePublicRuns(options: BuddyConversationTreeOptions, conversationId: string, branchId: string, threadId: string, throughSequence: number): RunRecord[] {
  const branches = new Set(options.repository.listPublicBranchIds(conversationId, branchId))
  const sources = new Set(options.repository.listPublications(conversationId, branchId, throughSequence).map(material => material.sourceId))
  return options.repository.listRuns(conversationId).filter((run) => {
    if (options.isRunHistoryAvailable?.(run.id) === false || run.threadId !== threadId || !branches.has(run.branchId) || run.status === 'queued' || run.status === 'running')
      return false
    if (options.repository.getRunPublicBoundary(run.id, 'after') > throughSequence)
      return false
    const owned = options.repository.listPublications(conversationId, run.branchId).filter(material => material.runId === run.id)
    return owned.every(material => sources.has(material.sourceId))
      && (run.branchId === branchId || owned.length > 0 || run.purpose === 'conversation.compaction')
  }).reverse()
}

function isPublicCheckpoint(manager: SessionManager, entryId: string, materials: ReturnType<ConversationTreeRepository['listPublications']>, options: BuddyConversationTreeOptions): boolean {
  const sources = new Set(materials.map(material => material.sourceId))
  const inputIds = new Set(materials.flatMap(material => material.kind === 'message' && material.role === 'user' ? [material.messageId] : []))
  const previous = manager.getLeafId()
  try {
    manager.branch(entryId)
    const branch = manager.getBranch()
    const runs = branch.flatMap((entry) => {
      const checkpoint = readCheckpoint(entry)
      const run = checkpoint ? options.runs.findById(checkpoint.runId) : null
      return run ? [run] : []
    })
    for (const entry of branch) {
      const checkpoint = readCheckpoint(entry)
      if (checkpoint && options.isRunHistoryAvailable?.(checkpoint.runId) === false)
        return false
      const completed = checkpoint?.position === 'after' ? options.runs.findById(checkpoint.runId) : null
      if (completed && options.repository.listPublications(completed.conversationId, completed.branchId).some(material => material.runId === completed.id && !sources.has(material.sourceId)))
        return false
      if (entry.type === 'custom_message' && entry.customType === PUBLIC_CONTEXT_TYPE) {
        const parsed = publicConversationMaterialSchema.safeParse(entry.details)
        if (!parsed.success || !sources.has(parsed.data.sourceId))
          return false
      }
      if (entry.type === 'message') {
        const input = readBuddyInputReference(entry.message)
        if (input && !inputIds.has(input.messageId) && !runs.some(run => run.executionKind === 'actor_child' && run.triggeringMessageId === input.messageId))
          return false
      }
    }
    return true
  }
  finally {
    if (previous)
      manager.branch(previous)
    else
      manager.resetLeaf()
  }
}
