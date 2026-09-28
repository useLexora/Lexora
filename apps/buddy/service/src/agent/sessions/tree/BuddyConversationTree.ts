import type { Api, Model } from '@earendil-works/pi-ai'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { ConversationHistoryRepository } from '../../../storage/conversationHistoryRepository'
import type { ConversationTreeRepository } from '../../../storage/conversationTreeRepository'
import type { RunRecord } from '../../../storage/runRecord'
import type { RunRepository } from '../../../storage/runRepository'
import type { BuddySessionRecoveryService } from '../recovery/BuddySessionRecoveryService'
import type { BuddyTreeJournal } from './BuddyTreeStore'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { BuddyAgentRunError } from '../../../runs/runError'
import { BuddyTreeRecovery } from './BuddyTreeRecovery'
import { BuddyTreeStore, readCheckpoint } from './BuddyTreeStore'

export interface BuddyConversationTreeOptions {
  conversationsDirectory: string
  conversations: Pick<ConversationHistoryRepository, 'listBranchMessages'>
  repository: ConversationTreeRepository
  runs: Pick<RunRepository, 'findById'>
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
    const previous = this.#openings.get(run.conversationId) ?? Promise.resolve()
    const result = this.#run(() => previous.catch(() => {}).then(() => this.#open(captured, cwd, model)))
    this.#openings.set(run.conversationId, result)
    void result.finally(() => {
      if (this.#openings.get(run.conversationId) === result)
        this.#openings.delete(run.conversationId)
    }).catch(() => {})
    return result
  }

  async #open(run: RunRecord, cwd: string, model: Model<Api>) {
    const journal = await this.#store.open(run.conversationId, cwd)
    const cursor = new BuddyConversationTreeCursor(this.#options, journal, model)
    cursor.manager.branch(await cursor.resolveStart(run))
    return cursor
  }

  preview(conversationId: string, branchId: string, cwd: string, model: Model<Api>, legacySessionFile: string | null) {
    return this.#run(() => this.#preview(conversationId, branchId, cwd, model, legacySessionFile))
  }

  async #preview(conversationId: string, branchId: string, cwd: string, model: Model<Api>, legacySessionFile: string | null) {
    const snapshot = await this.#snapshot(conversationId, branchId, cwd)
    if (snapshot)
      return snapshot
    const legacy = await this.#store.readLegacy(conversationId, cwd, legacySessionFile)
    if (legacy)
      return legacy.manager
    const recovered = await this.#options.recovery.create({
      conversationId,
      branchId,
      fallbackModel: model,
      point: { kind: 'branch_head' },
    })
    const manager = SessionManager.inMemory(cwd)
    for (const message of recovered.messages)
      manager.appendMessage(message)
    return manager
  }

  snapshot(conversationId: string, branchId: string, cwd: string, sourceRunId?: string, position: 'before' | 'after' = 'after'): Promise<SessionManager | null> {
    return this.#run(() => this.#snapshot(conversationId, branchId, cwd, sourceRunId, position))
  }

  async #snapshot(conversationId: string, branchId: string, cwd: string, sourceRunId?: string, position: 'before' | 'after' = 'after'): Promise<SessionManager | null> {
    const journal = await this.#store.read(conversationId, cwd)
    if (!journal)
      return null
    const checkpoint = journal.manager.getEntries().findLast((entry) => {
      const checkpoint = readCheckpoint(entry)
      return checkpoint?.branchId === branchId && checkpoint.position === position
        && (!sourceRunId || checkpoint.runId === sourceRunId)
    })
    if (!checkpoint)
      return null
    journal.validateAncestry(checkpoint.id)
    journal.manager.branch(checkpoint.id)
    return journal.manager
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
    this.#journal.assertConversation(run.conversationId)
    const explicit = this.#options.repository.findSource(run.id)
    if (explicit)
      return this.#checkpoint(explicit.sourceRunId, explicit.position)
    const history = this.#options.conversations.listBranchMessages(run.conversationId, run.branchId)
    const boundary = run.purpose === 'conversation.compaction' ? history.length : history.findIndex(message => message.id === run.triggeringMessageId)
    if (boundary < 0)
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    const visible = new Set(history.slice(0, boundary).filter(message => message.role === 'user').map(message => message.id))
    const earlier = this.#options.repository.listRuns(run.conversationId).filter(candidate => candidate.id !== run.id
      && candidate.branchId === run.branchId && visible.has(candidate.triggeringMessageId)
      && candidate.status !== 'queued' && candidate.status !== 'running' && candidate.startedAt <= run.startedAt)
    const latest = earlier.at(-1)
    if (latest)
      return this.#checkpoint(latest.id, 'after')
    for (const message of history.slice(0, boundary).reverse()) {
      if (message.runId)
        return this.#checkpoint(message.runId, 'after')
      if (message.role === 'user') {
        const previous = this.#options.repository.listRuns(run.conversationId).filter(candidate => candidate.id !== run.id
          && candidate.branchId === message.branchId && candidate.triggeringMessageId === message.id).at(-1)
        if (previous)
          return this.#checkpoint(previous.id, 'after')
      }
    }
    return this.rootId
  }

  async #checkpoint(runId: string, position: 'before' | 'after'): Promise<string> {
    const key = `${runId}:${position}`
    const run = this.#options.runs.findById(runId)
    if (!run || this.#resolving.has(key))
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    this.#journal.assertConversation(run.conversationId)
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
