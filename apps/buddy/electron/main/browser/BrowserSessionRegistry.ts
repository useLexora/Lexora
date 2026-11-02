import { randomUUID } from 'node:crypto'

export type BrowserSessionProtection = 'operation' | 'runtime' | 'surface' | 'tab'
export type BrowserSessionTeardownReason = 'closed' | 'disposed' | 'evicted'

export interface BrowserSessionFactoryContext {
  conversationId: string | null
  sessionId: string
}

export interface BrowserSessionFactoryResult<Session> {
  session: Session
  teardown: (reason: BrowserSessionTeardownReason) => void | Promise<void>
}

interface BrowserSessionEntry<Session> extends BrowserSessionFactoryContext {
  tabId: string
  lastUsed: number
  protections: Set<BrowserSessionProtection>
  session: Session
  teardown: (reason: BrowserSessionTeardownReason) => void | Promise<void>
}

interface BrowserSessionRegistryOptions {
  createId?: () => string
  maxSessions?: number
}

export class BrowserSessionRegistryError extends Error {
  readonly code = 'BROWSER_SESSION_LIMIT_REACHED' as const

  constructor() {
    super('Every browser session is protected')
    this.name = 'BrowserSessionRegistryError'
  }
}

export class BrowserSessionRegistry<Session> {
  readonly #byTab = new Map<string, BrowserSessionEntry<Session>>()
  readonly #bySessionId = new Map<string, BrowserSessionEntry<Session>>()
  readonly #retiring = new Set<Promise<void>>()
  readonly #createId: () => string
  readonly #maxSessions: number
  #clock = 0
  #disposed = false

  constructor(options: BrowserSessionRegistryOptions = {}) {
    this.#createId = options.createId ?? randomUUID
    this.#maxSessions = options.maxSessions ?? 16
    if (!Number.isInteger(this.#maxSessions) || this.#maxSessions < 1)
      throw new RangeError('Browser session limit must be a positive integer')
  }

  ensure(
    conversationId: string | null,
    createSession: (
      context: BrowserSessionFactoryContext,
    ) => BrowserSessionFactoryResult<Session>,
    tabId = 'default',
  ): Session {
    this.#assertActive()
    if (conversationId === null && (!tabId || tabId === 'default'))
      throw new Error('Standalone browser sessions require a tab identity')
    const key = JSON.stringify([conversationId, tabId])
    const existing = this.#byTab.get(key)
    if (existing) {
      this.#touchEntry(existing)
      return existing.session
    }

    const evictionCandidate = this.#findEvictionCandidate()
    if (this.#bySessionId.size + this.#retiring.size >= this.#maxSessions) {
      if (this.#retiring.size > 0)
        throw new BrowserSessionRegistryError()
      if (evictionCandidate)
        this.#removeEntry(evictionCandidate, 'evicted')
      if (this.#bySessionId.size + this.#retiring.size >= this.#maxSessions)
        throw new BrowserSessionRegistryError()
    }

    const sessionId = this.#createId()
    const created = createSession({ conversationId, sessionId })

    const entry: BrowserSessionEntry<Session> = {
      tabId,
      conversationId,
      lastUsed: ++this.#clock,
      protections: new Set(tabId === 'default' || tabId.startsWith('agent:') ? [] : ['tab']),
      session: created.session,
      sessionId,
      teardown: created.teardown,
    }
    this.#byTab.set(key, entry)
    this.#bySessionId.set(sessionId, entry)
    return entry.session
  }

  get(sessionId: string): Session | undefined {
    return this.#bySessionId.get(sessionId)?.session
  }

  getByConversation(conversationId: string): Session | undefined {
    return this.getByTab(conversationId, 'default')
  }

  getByTab(conversationId: string | null, tabId: string): Session | undefined {
    return this.#byTab.get(JSON.stringify([conversationId, tabId]))?.session
  }

  getTabId(sessionId: string): string | undefined {
    return this.#bySessionId.get(sessionId)?.tabId
  }

  touch(sessionId: string): boolean {
    const entry = this.#bySessionId.get(sessionId)
    if (!entry)
      return false
    this.#touchEntry(entry)
    return true
  }

  setProtected(
    sessionId: string,
    protection: BrowserSessionProtection,
    isProtected: boolean,
  ): boolean {
    const entry = this.#bySessionId.get(sessionId)
    if (!entry)
      return false
    if (isProtected)
      entry.protections.add(protection)
    else
      entry.protections.delete(protection)
    this.#touchEntry(entry)
    return true
  }

  remove(sessionId: string): boolean {
    const entry = this.#bySessionId.get(sessionId)
    if (!entry)
      return false
    this.#removeEntry(entry, 'closed')
    return true
  }

  values(): Session[] {
    return [...this.#bySessionId.values()].map(entry => entry.session)
  }

  dispose(): void {
    if (this.#disposed)
      return
    this.#disposed = true
    for (const entry of [...this.#bySessionId.values()])
      this.#removeEntry(entry, 'disposed')
  }

  #assertActive(): void {
    if (this.#disposed)
      throw new Error('Browser session registry is disposed')
  }

  #findEvictionCandidate(): BrowserSessionEntry<Session> | undefined {
    if (this.#bySessionId.size + this.#retiring.size < this.#maxSessions)
      return undefined
    return [...this.#bySessionId.values()]
      .filter(entry => entry.protections.size === 0)
      .sort((left, right) => left.lastUsed - right.lastUsed)
      .at(0)
  }

  #removeEntry(
    entry: BrowserSessionEntry<Session>,
    reason: BrowserSessionTeardownReason,
  ): void {
    this.#byTab.delete(JSON.stringify([entry.conversationId, entry.tabId]))
    this.#bySessionId.delete(entry.sessionId)
    const cleanup = entry.teardown(reason)
    if (cleanup) {
      this.#retiring.add(cleanup)
      void cleanup.then(() => this.#retiring.delete(cleanup), () => {})
    }
  }

  #touchEntry(entry: BrowserSessionEntry<Session>): void {
    entry.lastUsed = ++this.#clock
  }
}
