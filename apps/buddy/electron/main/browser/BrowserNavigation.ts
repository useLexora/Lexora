import type { DesktopBrowserError, DesktopBrowserState } from '../../../shared/browser/browserDesktopApi'
import type { Event } from '../../../shared/events/Emitter'
import type { BrowserHostChange } from './BrowserHostEvents'
import type { BrowserOperationGuard } from './BrowserOperationGuard'
import type { BrowserPage, BrowserPageSession } from './BrowserPageSession'
import type { BrowserSessionRegistry } from './BrowserSessionRegistry'
import { BrowserHostError } from './BrowserHostError'
import { snapshot } from './BrowserPageSession'
import { BrowserSecurityPolicyError } from './BrowserSecurityPolicy'

const BROWSER_NAVIGATION_WAIT_TIMEOUT_MS = 30_000
const BROWSER_FAILED_NAVIGATION_SETTLE_MS = 200
const BROWSER_NAVIGATION_SETTLE_TIMEOUT_MS = 15_000

export interface BrowserLocalFileGrant {
  entryPath: string
  rootPath: string
}

interface BrowserNavigationOptions {
  sessions: Pick<BrowserSessionRegistry<BrowserPageSession>, 'get' | 'touch'>
  operations: Pick<BrowserOperationGuard, 'assertCanMutate'>
  requireSession: (id: string) => BrowserPageSession
  waitForPage: (session: BrowserPageSession) => Promise<BrowserPage>
  assertCurrentPage: (session: BrowserPageSession, pageId: string, operation: string) => void
  notFound: (id: string) => BrowserHostError
  onDidChange: Event<BrowserHostChange>
  recordTiming: (session: BrowserPageSession, phase: 'guest_ready' | 'authorized' | 'document_ready' | 'load_complete', startedAt: number) => void
}

export class BrowserNavigation {
  readonly #options: BrowserNavigationOptions
  readonly #failedNavigationTargets = new WeakMap<BrowserPageSession, string>()

  constructor(options: BrowserNavigationOptions) {
    this.#options = options
  }

  release(session: BrowserPageSession): void {
    this.#failedNavigationTargets.delete(session)
  }

  async navigate(sessionId: string, rawUrl: string, readiness: 'load' | 'document-ready' = 'load', assertControl: () => void = () => {}): Promise<DesktopBrowserState> {
    assertControl()
    this.#options.operations.assertCanMutate()
    const session = this.#options.requireSession(sessionId)
    const startedAt = performance.now()
    const navigationSequence = this.#beginPageAction(session)
    let url: string
    try {
      await this.#options.waitForPage(session)
      this.#options.requireSession(sessionId)
      if (!this.#shouldContinuePageAction(session, navigationSequence))
        return snapshot(session.state)
      this.#options.recordTiming(session, 'guest_ready', startedAt)
      this.#assertNavigationControl(session, navigationSequence, assertControl)
      this.#options.operations.assertCanMutate()
      const authorizationStartedAt = performance.now()
      url = await session.securityPolicy?.authorizeNavigation(rawUrl) ?? ''
      this.#options.recordTiming(session, 'authorized', authorizationStartedAt)
    }
    catch (error) {
      this.#options.requireSession(sessionId)
      if (error instanceof BrowserHostError && error.code === 'BROWSER_CONTROL_REQUIRED')
        throw error
      if (session.state.error?.code === 'BROWSER_PAGE_UNRESPONSIVE')
        throw new BrowserHostError('BROWSER_PAGE_UNRESPONSIVE', session.state.error.message)
      if (!this.#shouldContinuePageAction(session, navigationSequence))
        return snapshot(session.state)
      this.#failedNavigationTargets.set(session, rawUrl)
      const failure: DesktopBrowserError = error instanceof BrowserSecurityPolicyError
        ? { code: error.code, message: error.message, reason: error.reason }
        : { code: 'BROWSER_PAGE_FAILED', message: browserLoadErrorMessage(error) }
      session.state.error = failure
      session.state.status = 'error'
      this.#finishPageAction(session, navigationSequence)
      session.publish()
      throw error instanceof BrowserHostError
        ? error
        : new BrowserHostError(failure.code, failure.message, failure.reason)
    }
    if (!this.#shouldContinuePageAction(session, navigationSequence))
      return snapshot(session.state)

    this.#assertNavigationControl(session, navigationSequence, assertControl)
    return this.#loadPage(sessionId, session, navigationSequence, url, readiness, assertControl)
  }

  async #loadPage(
    sessionId: string,
    session: BrowserPageSession,
    navigationSequence: number,
    url: string,
    readiness: 'load' | 'document-ready',
    assertControl: () => void,
  ): Promise<DesktopBrowserState> {
    return session.runWhileActive(async () => {
      const startedAt = performance.now()
      const page = session.requirePage()
      const pageId = session.state.pageId
      let hasCommittedDocument = false
      let resolveWait!: (state: DesktopBrowserState) => void
      let rejectWait!: (error: unknown) => void
      const waiting = new Promise<DesktopBrowserState>((resolve, reject) => {
        resolveWait = resolve
        rejectWait = reject
      })
      const checkInterrupted = (): boolean => {
        try {
          this.#options.requireSession(sessionId)
          this.#options.assertCurrentPage(session, pageId, 'while waiting for navigation')
          assertControl()
          if (!this.#shouldContinuePageAction(session, navigationSequence)) {
            resolveWait(snapshot(session.state))
            return true
          }
          const error = session.state.error
          if (error?.code === 'BROWSER_PAGE_CRASHED' || error?.code === 'BROWSER_PAGE_UNRESPONSIVE')
            throw new BrowserHostError(error.code, error.message, error.reason)
          return false
        }
        catch (error) {
          rejectWait(error)
          return true
        }
      }
      const onDocumentCommitted = () => {
        if (this.#shouldContinuePageAction(session, navigationSequence))
          hasCommittedDocument = true
      }
      const onDocumentReady = () => {
        if (checkInterrupted() || readiness !== 'document-ready' || session.mainFrameCommitSequence !== navigationSequence)
          return
        this.#options.recordTiming(session, 'document_ready', startedAt)
        resolveWait(snapshot(session.state))
      }
      const subscription = this.#options.onDidChange((change) => {
        if ((change.kind === 'state' || change.kind === 'session') && change.state.sessionId === sessionId)
          checkInterrupted()
      })
      page.on('did-navigate', onDocumentCommitted)
      page.on('dom-ready', onDocumentReady)
      const timer = setTimeout(() => {
        if (checkInterrupted())
          return
        const failure = session.state.error
        if (failure) {
          rejectWait(new BrowserHostError(failure.code, failure.message, failure.reason))
          return
        }
        if (hasCommittedDocument && session.mainFrameCommitSequence === navigationSequence) {
          resolveWait(snapshot(session.state))
          return
        }
        const message = 'Browser navigation did not commit before its deadline'
        rejectWait(new BrowserHostError('BROWSER_PAGE_FAILED', message))
        session.navigationSequence += 1
        this.#finishPageAction(session, navigationSequence)
        this.#failedNavigationTargets.set(session, url)
        session.state.error = { code: 'BROWSER_PAGE_FAILED', message }
        session.state.status = 'error'
        try {
          page.stop()
        }
        catch {}
        session.publish()
      }, BROWSER_NAVIGATION_WAIT_TIMEOUT_MS)
      try {
        return await Promise.race([
          waiting,
          this.#loadPageToCompletion(sessionId, session, navigationSequence, url, assertControl),
        ])
      }
      finally {
        clearTimeout(timer)
        subscription.dispose()
        page.off('did-navigate', onDocumentCommitted)
        page.off('dom-ready', onDocumentReady)
      }
    }, { timeoutMs: null })
  }

  async #loadPageToCompletion(
    sessionId: string,
    session: BrowserPageSession,
    navigationSequence: number,
    url: string,
    assertControl: () => void,
  ): Promise<DesktopBrowserState> {
    const startedAt = performance.now()
    session.state.url = url
    session.publish()
    try {
      const page = await this.#options.waitForPage(session)
      if (!this.#shouldContinuePageAction(session, navigationSequence))
        return snapshot(session.state)
      this.#assertNavigationControl(session, navigationSequence, assertControl)
      await page.loadURL(url)
      this.#options.recordTiming(session, 'load_complete', startedAt)
      if (!this.#options.sessions.get(sessionId))
        throw this.#options.notFound(sessionId)
      if (!this.#isCurrentPageAction(session, navigationSequence))
        return snapshot(session.state)
      session.stoppedNavigationSequence = null
      this.#finishPageAction(session, navigationSequence)
      session.removeBootstrapHistory()
      session.refreshPageState()
      session.state.status = 'ready'
      session.publish()
      return snapshot(session.state)
    }
    catch (error) {
      if (error instanceof BrowserHostError)
        throw error
      if (!this.#options.sessions.get(sessionId))
        throw this.#options.notFound(sessionId)
      if (!this.#isCurrentPageAction(session, navigationSequence))
        return snapshot(session.state)
      if (session.stoppedNavigationSequence === navigationSequence) {
        session.stoppedNavigationSequence = null
        this.#finishPageAction(session, navigationSequence)
        session.state.error = null
        session.state.status = session.state.url === 'about:blank' ? 'idle' : 'ready'
        session.refreshPageState()
        session.publish()
        return snapshot(session.state)
      }
      return this.#waitForNavigationSettlement(
        sessionId,
        session,
        navigationSequence,
        error,
      )
    }
  }

  async #waitForNavigationSettlement(
    sessionId: string,
    session: BrowserPageSession,
    navigationSequence: number,
    loadError: unknown,
  ): Promise<DesktopBrowserState> {
    const startedAt = Date.now()
    const deadline = startedAt + BROWSER_NAVIGATION_SETTLE_TIMEOUT_MS
    const isAbortedLoad = isNavigationAborted(loadError)
    const loadFailureDeadline = isAbortedLoad
      ? null
      : Math.min(deadline, startedAt + BROWSER_FAILED_NAVIGATION_SETTLE_MS)
    let pageFailureDeadline: number | null = null
    while (true) {
      if (this.#options.sessions.get(sessionId) !== session)
        throw this.#options.notFound(sessionId)
      if (!this.#isCurrentPageAction(session, navigationSequence))
        return snapshot(session.state)
      if (session.stoppedNavigationSequence === navigationSequence) {
        session.stoppedNavigationSequence = null
        this.#finishPageAction(session, navigationSequence)
        session.state.error = null
        session.state.status = session.state.url === 'about:blank' ? 'idle' : 'ready'
        session.refreshPageState()
        session.publish()
        return snapshot(session.state)
      }
      const hasReplacementCommit = session.mainFrameCommitSequence === navigationSequence
      const pageFailure = session.state.error
      const now = Date.now()
      if (pageFailure) {
        pageFailureDeadline ??= Math.min(
          deadline,
          now + BROWSER_FAILED_NAVIGATION_SETTLE_MS,
        )
      }
      else {
        pageFailureDeadline = null
      }
      if (
        pageFailure
        && (
          session.activeNavigationSequence !== navigationSequence
          || now >= (pageFailureDeadline ?? deadline)
        )
      ) {
        this.#finishPageAction(session, navigationSequence)
        throw new BrowserHostError(
          pageFailure.code,
          pageFailure.message,
          pageFailure.reason ?? null,
        )
      }
      if (
        session.state.status === 'ready'
        && (isAbortedLoad || hasReplacementCommit)
      ) {
        return snapshot(session.state)
      }
      if (loadFailureDeadline !== null && now >= loadFailureDeadline) {
        const message = browserLoadErrorMessage(loadError)
        this.#finishPageAction(session, navigationSequence)
        session.state.error = { code: 'BROWSER_PAGE_FAILED', message }
        session.state.status = 'error'
        session.publish()
        throw new BrowserHostError('BROWSER_PAGE_FAILED', message)
      }
      const remainingMs = Math.min(
        pageFailureDeadline ?? deadline,
        loadFailureDeadline ?? deadline,
      ) - now
      if (remainingMs <= 0) {
        const message = 'Browser navigation did not settle after the initial load was replaced'
        this.#finishPageAction(session, navigationSequence)
        session.state.error = { code: 'BROWSER_PAGE_FAILED', message }
        session.state.status = 'error'
        session.publish()
        throw new BrowserHostError('BROWSER_PAGE_FAILED', message)
      }
      await wait(Math.min(remainingMs, 50))
    }
  }

  goBack(sessionId: string): void {
    this.#options.operations.assertCanMutate()
    const session = this.#options.requireSession(sessionId)
    const history = session.requirePage().navigationHistory
    if (!history.canGoBack())
      return
    this.#beginPageAction(session)
    history.goBack()
  }

  goForward(sessionId: string): void {
    this.#options.operations.assertCanMutate()
    const session = this.#options.requireSession(sessionId)
    const history = session.requirePage().navigationHistory
    if (!history.canGoForward())
      return
    this.#beginPageAction(session)
    history.goForward()
  }

  async reload(sessionId: string, assertControl: () => void = () => {}): Promise<void> {
    assertControl()
    this.#options.operations.assertCanMutate()
    const session = this.#options.requireSession(sessionId)
    const failedTarget = this.#failedNavigationTargets.get(session)
    if (session.state.status === 'error' && failedTarget !== undefined) {
      await this.navigate(sessionId, failedTarget, 'load', assertControl)
      return
    }
    if (session.state.url === 'about:blank')
      return
    this.#beginPageAction(session)
    session.requirePage().reload()
  }

  stop(sessionId: string): void {
    const session = this.#options.requireSession(sessionId)
    if (session.state.status !== 'loading')
      return
    session.stoppedNavigationSequence = session.navigationSequence
    this.#finishPageAction(session, session.navigationSequence)
    if (session.page && !session.page.isDestroyed())
      session.page.stop()
    session.refreshPageState()
    session.state.error = null
    session.state.status = session.state.url === 'about:blank' ? 'idle' : 'ready'
    session.publish()
  }

  async openLocalFile(
    sessionId: string,
    grant: BrowserLocalFileGrant,
    readiness: 'load' | 'document-ready' = 'load',
    assertControl: () => void = () => {},
  ): Promise<DesktopBrowserState> {
    assertControl()
    this.#options.operations.assertCanMutate()
    const session = this.#options.requireSession(sessionId)
    const startedAt = performance.now()
    await this.#options.waitForPage(session)
    this.#options.recordTiming(session, 'guest_ready', startedAt)
    this.#options.operations.assertCanMutate()
    const navigationSequence = this.#beginPageAction(session)
    const authorizationStartedAt = performance.now()
    let url: string
    try {
      url = await session.securityPolicy?.authorizeLocalFile(
        grant.entryPath,
        grant.rootPath,
      ) ?? ''
      this.#options.recordTiming(session, 'authorized', authorizationStartedAt)
    }
    catch (error) {
      if (session.state.error?.code === 'BROWSER_PAGE_UNRESPONSIVE')
        throw new BrowserHostError('BROWSER_PAGE_UNRESPONSIVE', session.state.error.message)
      if (!(error instanceof BrowserSecurityPolicyError))
        throw error
      if (!this.#shouldContinuePageAction(session, navigationSequence))
        return snapshot(session.state)
      session.state.error = {
        code: error.code,
        message: error.message,
        reason: error.reason,
      }
      session.state.status = 'error'
      this.#finishPageAction(session, navigationSequence)
      session.publish()
      throw new BrowserHostError(error.code, error.message, error.reason)
    }
    if (!this.#shouldContinuePageAction(session, navigationSequence))
      return snapshot(session.state)
    this.#assertNavigationControl(session, navigationSequence, assertControl)
    return this.#loadPage(sessionId, session, navigationSequence, url, readiness, assertControl)
  }

  #beginPageAction(session: BrowserPageSession): number {
    this.#failedNavigationTargets.delete(session)
    this.#options.sessions.touch(session.state.sessionId)
    session.navigationSequence += 1
    session.activeNavigationSequence = session.navigationSequence
    session.semanticDriver?.invalidateDocument()
    session.stoppedNavigationSequence = null
    session.state.error = null
    session.state.status = 'loading'
    session.publish()
    return session.navigationSequence
  }

  #isCurrentPageAction(session: BrowserPageSession, navigationSequence: number): boolean {
    return session.navigationSequence === navigationSequence
  }

  #finishPageAction(session: BrowserPageSession, navigationSequence: number): void {
    if (session.activeNavigationSequence === navigationSequence)
      session.activeNavigationSequence = null
  }

  #assertNavigationControl(session: BrowserPageSession, navigationSequence: number, assertControl: () => void): void {
    try {
      assertControl()
    }
    catch (error) {
      if (this.#shouldContinuePageAction(session, navigationSequence)) {
        this.#finishPageAction(session, navigationSequence)
        session.refreshPageState()
        session.state.error = null
        session.state.status = session.page?.isLoading() ? 'loading' : session.state.url === 'about:blank' ? 'idle' : 'ready'
        session.publish()
      }
      throw error
    }
  }

  #shouldContinuePageAction(session: BrowserPageSession, navigationSequence: number): boolean {
    return this.#isCurrentPageAction(session, navigationSequence)
      && session.stoppedNavigationSequence !== navigationSequence
  }
}

function isNavigationAborted(error: unknown): boolean {
  if (!error || typeof error !== 'object')
    return false
  const candidate = error as { code?: unknown, errno?: unknown }
  if (candidate.code === 'ERR_ABORTED' || candidate.errno === -3)
    return true
  return error instanceof Error
    && /^ERR_ABORTED(?: \(-3\))?(?: |$)/.test(error.message)
}

function browserLoadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim())
    return error.message.slice(0, 1_024)
  return 'Browser page failed to load'
}

function wait(durationMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, durationMs))
}
