import type { BrowserWindow, Event as ElectronEvent, WebPreferences } from 'electron'
import type {
  BrowserAcquireControlParams,
  BrowserAction,
  BrowserActParams,
  BrowserControlLease,
  BrowserObservation,
  BrowserObserveParams,
  BrowserReleaseControlParams,
  BrowserValidateActionParams,
  BrowserWaitOutcome,
  BrowserWaitSpec,
} from '../../../shared/browser'
import type {
  DesktopBrowserGuestDescriptor,
  DesktopBrowserProfileMode,
  DesktopBrowserSetSurfaceInput,
  DesktopBrowserState,
} from '../../../shared/browser/browserDesktopApi'
import type { BrowserPage } from './BrowserPageSession'
import type { BrowserSessionTeardownReason } from './BrowserSessionRegistry'
import type { SemanticBrowserDriver, SemanticBrowserScreenshot, SemanticBrowserScreenshotReference } from './SemanticBrowserDriver'
import { randomUUID } from 'node:crypto'
import { BROWSER_WAIT_DEFAULT_QUIET_MS } from '../../../shared/browser'
import { BrowserHostError } from './BrowserHostError'
import { BrowserOperationGuard } from './BrowserOperationGuard'
import { BrowserPageSession, snapshot } from './BrowserPageSession'
import {
  BrowserSecurityPolicyError,
} from './BrowserSecurityPolicy'
import {
  BrowserSessionRegistry,
  BrowserSessionRegistryError,
} from './BrowserSessionRegistry'
import {
  SemanticBrowserDriverError,
} from './SemanticBrowserDriver'

export const BROWSER_DEFAULT_PARTITION = 'persist:buddy-browser-default-v1'
const BROWSER_GUEST_ATTACH_TIMEOUT_MS = 10_000
const BROWSER_FAILED_NAVIGATION_SETTLE_MS = 200
const BROWSER_NAVIGATION_SETTLE_TIMEOUT_MS = 15_000
const BROWSER_ACTION_NAVIGATION_DETECTION_MS = 50
const BROWSER_WAIT_STATE_INTERVAL_MS = 50
const BROWSER_WAIT_PROBE_INTERVAL_MS = 150

interface BrowserHostOptions {
  getFreezeDelay?: (visible: boolean) => number | null
  onActivityError?: () => void
  getDefaultZoomFactor?: () => number
  operations?: BrowserOperationGuard
  createId?: () => string
  createPage?: (descriptor: DesktopBrowserGuestDescriptor) => BrowserPage
  onGuestSetChanged?: () => void
  onSessionClosed?: (
    state: DesktopBrowserState,
    reason: BrowserSessionTeardownReason,
  ) => void
  onStateChanged?: (state: DesktopBrowserState) => void
  window: BrowserWindow
}

type BrowserWaitAction = Extract<BrowserAction, { kind: 'wait' }>
type BrowserWaitRequest = BrowserWaitAction | BrowserWaitSpec

export interface BrowserLocalFileGrant {
  entryPath: string
  rootPath: string
}

export interface BrowserScreenshotReadInput extends SemanticBrowserScreenshotReference {
  pageId: string
  sessionId: string
}

export interface BrowserHostActionResult {
  actionKind: BrowserAction['kind']
  observation: BrowserObservation
  state: DesktopBrowserState
}

export interface BrowserPageScreenshot {
  bytes: Uint8Array
  title: string
}

export class BrowserHost {
  readonly #getFreezeDelay: (visible: boolean) => number | null
  readonly #onActivityError: () => void
  readonly #getDefaultZoomFactor: () => number
  readonly #operations: BrowserOperationGuard
  readonly #createId: () => string
  readonly #createPage: ((descriptor: DesktopBrowserGuestDescriptor) => BrowserPage) | null
  readonly #evictedConversationIds = new Set<string>()
  readonly #onSessionClosed: (
    state: DesktopBrowserState,
    reason: BrowserSessionTeardownReason,
  ) => void

  readonly #onStateChanged: (state: DesktopBrowserState) => void
  readonly #onGuestSetChanged: () => void
  readonly #sessions: BrowserSessionRegistry<BrowserPageSession>
  readonly #window: BrowserWindow
  readonly #windowClosedListener: () => void
  readonly #willAttachWebviewListener: (
    event: ElectronEvent,
    webPreferences: WebPreferences,
    params: Record<string, string>,
  ) => void

  #disposed = false
  constructor(options: BrowserHostOptions) {
    this.#getFreezeDelay = options.getFreezeDelay ?? (() => null)
    this.#onActivityError = options.onActivityError ?? (() => {})
    this.#operations = options.operations ?? new BrowserOperationGuard()
    this.#getDefaultZoomFactor = options.getDefaultZoomFactor ?? (() => 1)
    this.#createId = options.createId ?? randomUUID
    this.#createPage = options.createPage ?? null
    this.#onGuestSetChanged = options.onGuestSetChanged ?? (() => {})
    this.#onSessionClosed = options.onSessionClosed ?? (() => {})
    this.#onStateChanged = options.onStateChanged ?? (() => {})
    this.#sessions = new BrowserSessionRegistry({
      createId: this.#createId,
      maxSessions: 4,
    })
    this.#window = options.window
    this.#windowClosedListener = () => this.dispose()
    this.#willAttachWebviewListener = (event, webPreferences, params) => {
      this.#configureGuestAttachment(event, webPreferences, params)
    }
    this.#window.once('closed', this.#windowClosedListener)
    this.#window.webContents.on('will-attach-webview', this.#willAttachWebviewListener)
  }

  get isDisposed(): boolean {
    return this.#disposed
  }

  hasAgentControl(): boolean {
    return this.#sessions.values().some(session => session.state.controller === 'agent')
  }

  async updateActivity(): Promise<void> {
    await Promise.all(this.#sessions.values().map(session => session.updateActivity()))
  }

  async setZoomFactor(sessionId: string, factor: number | null): Promise<DesktopBrowserState> {
    this.#operations.assertCanMutate()
    const session = this.#requireSession(sessionId)
    await this.#waitForPage(session)
    this.#requireSession(sessionId)
    return session.setZoomFactor(factor)
  }

  ensureSession(conversationId: string | null, tabId?: string): DesktopBrowserState {
    return this.#ensureSession(conversationId, 'default', tabId)
  }

  async setProfileMode(
    sessionId: string,
    profileMode: DesktopBrowserProfileMode,
  ): Promise<DesktopBrowserState> {
    this.#operations.assertCanMutate()
    const current = this.#requireSession(sessionId)
    if (current.state.profileMode === profileMode)
      return snapshot(current.state)
    if (current.state.controller === 'agent')
      this.#returnHumanControl(current, true)
    return this.#replaceSessionProfile(current, profileMode)
  }

  #ensureSession(
    conversationId: string | null,
    profileMode: DesktopBrowserProfileMode,
    tabId?: string,
  ): DesktopBrowserState {
    this.#operations.assertCanMutate()
    this.#assertActive()
    let wasCreated = false
    try {
      const session = this.#sessions.ensure(conversationId, ({ sessionId }) => {
        wasCreated = true
        const session = this.#createSession(conversationId, sessionId, profileMode)
        return {
          session,
          teardown: reason => this.#teardownSession(session, reason),
        }
      }, tabId)
      if (wasCreated && conversationId && this.#evictedConversationIds.delete(conversationId)) {
        session.state.error = {
          code: 'BROWSER_SESSION_EVICTED',
          message: 'Inactive browser session was released',
        }
        session.state.status = 'error'
      }
      if (wasCreated)
        this.#onGuestSetChanged()
      if (wasCreated)
        this.#publish(session)
      return snapshot(session.state)
    }
    catch (error) {
      if (error instanceof BrowserSessionRegistryError) {
        throw new BrowserHostError(
          error.code,
          'Every browser session is currently protected',
        )
      }
      throw error
    }
  }

  getState(sessionId: string): DesktopBrowserState {
    return snapshot(this.#requireSession(sessionId).state)
  }

  getStateForConversation(conversationId: string): DesktopBrowserState {
    const session = this.#sessions.getByConversation(conversationId)
    if (!session)
      throw this.#sessionNotFound(conversationId)
    return snapshot(session.state)
  }

  listGuests(): DesktopBrowserGuestDescriptor[] {
    this.#assertActive()
    return this.#sessions.values().map(session => ({ ...session.descriptor }))
  }

  attachGuest(sessionId: string, page: BrowserPage): void {
    const session = this.#requireSession(sessionId)
    if (page.isDestroyed()) {
      throw new BrowserHostError(
        'BROWSER_PAGE_FAILED',
        'Browser guest was destroyed before attachment',
      )
    }
    if (session.page === page)
      return
    if (session.page && !session.page.isDestroyed()) {
      throw new BrowserHostError(
        'BROWSER_PAGE_FAILED',
        'Browser session already has an attached guest',
      )
    }
    session.attach(page)
  }

  getGuestDescriptor(sessionId: string): DesktopBrowserGuestDescriptor {
    return { ...this.#requireSession(sessionId).descriptor }
  }

  acquireControl(input: BrowserAcquireControlParams): BrowserControlLease {
    this.#operations.assertCanMutate()
    const session = this.#requireSession(input.sessionId)
    if (!session.state.conversationId)
      throw new BrowserHostError('BROWSER_CONTROL_REQUIRED', 'Standalone browser sessions remain under human control')
    this.#assertCurrentPage(session, input.pageId, 'before acquiring control')
    this.#advanceControlEpoch(session)
    session.state.controller = 'agent'
    this.#sessions.setProtected(input.sessionId, 'runtime', true)
    this.#publish(session)
    return {
      controller: 'agent',
      controlEpoch: session.state.controlEpoch,
      pageId: session.state.pageId,
      sessionId: session.state.sessionId,
    }
  }

  releaseControl(input: BrowserReleaseControlParams): DesktopBrowserState {
    const session = this.#requireSession(input.sessionId)
    this.#assertCurrentPage(session, input.pageId, 'before releasing control')
    this.#assertAgentControl(session, input.controlEpoch)
    return this.#returnHumanControl(session)
  }

  takeControl(sessionId: string): DesktopBrowserState {
    return this.#returnHumanControl(this.#requireSession(sessionId), true)
  }

  async observe(input: BrowserObserveParams): Promise<BrowserObservation> {
    const session = this.#requireSession(input.sessionId)
    if (session.state.pageId !== input.pageId) {
      return Promise.reject(new BrowserHostError(
        'BROWSER_TARGET_STALE',
        'Browser page identity changed before observation',
      ))
    }
    const recoverablePageError = session.state.status === 'error'
      && session.state.error?.code === 'BROWSER_PAGE_FAILED'
    if (session.state.status === 'error' && session.state.error && !recoverablePageError) {
      return Promise.reject(new BrowserHostError(
        session.state.error.code,
        session.state.error.message,
        session.state.error.reason ?? null,
      ))
    }
    this.#sessions.touch(input.sessionId)
    await this.#waitForPage(session)
    if (recoverablePageError)
      session.refreshPageState()
    const observation = await session.runWhileActive(() => this.#requireSemanticDriver(session).observe({
      maxElements: input.maxElements,
      pageId: session.state.pageId,
      sessionId: session.state.sessionId,
      status: recoverablePageError || session.state.status === 'idle'
        ? 'ready'
        : session.state.status,
      title: session.state.title,
      url: session.state.url,
    }))
    if (recoverablePageError) {
      session.state.error = null
      session.state.status = session.state.url === 'about:blank' ? 'idle' : 'ready'
      this.#publish(session)
    }
    return observation
  }

  validateAction(input: BrowserValidateActionParams): void {
    const session = this.#requireSession(input.sessionId)
    this.#assertCurrentPage(session, input.pageId, 'before approved action validation')
    if (session.state.status === 'error' && session.state.error) {
      throw new BrowserHostError(
        session.state.error.code,
        session.state.error.message,
        session.state.error.reason ?? null,
      )
    }
    this.#sessions.touch(input.sessionId)
    this.#requireSemanticDriver(session).validateAction({
      action: input.action,
      documentRevision: input.documentRevision,
      ...(input.frameId ? { frameId: input.frameId } : {}),
      observationId: input.observationId,
    })
  }

  async act(input: BrowserActParams): Promise<BrowserHostActionResult> {
    this.#operations.assertCanMutate()
    const queuedSession = this.#requireSession(input.sessionId)
    const predecessor = queuedSession.actionTail
    let releaseQueue!: () => void
    queuedSession.actionTail = new Promise((resolve) => {
      releaseQueue = resolve
    })
    await predecessor
    try {
      this.#operations.assertCanMutate()
      const session = this.#requireSession(input.sessionId)
      if (session !== queuedSession)
        throw this.#sessionNotFound(input.sessionId)
      this.#assertCurrentPage(session, input.pageId, 'before action')
      this.#assertAgentControl(session, input.controlEpoch)
      if (session.state.status === 'error' && session.state.error) {
        throw new BrowserHostError(
          session.state.error.code,
          session.state.error.message,
          session.state.error.reason ?? null,
        )
      }
      await this.#waitForPage(session)
      const semanticDriver = this.#requireSemanticDriver(session)
      this.#sessions.touch(input.sessionId)
      const reference = {
        documentRevision: input.documentRevision,
        observationId: input.observationId,
      }
      let mayStartNavigation = false
      switch (input.action.kind) {
        case 'navigate':
          semanticDriver.assertObservation(reference)
          await this.navigate(input.sessionId, input.action.url)
          break
        case 'back':
          semanticDriver.assertObservation(reference)
          this.goBack(input.sessionId)
          break
        case 'forward':
          semanticDriver.assertObservation(reference)
          this.goForward(input.sessionId)
          break
        case 'reload':
          semanticDriver.assertObservation(reference)
          this.reload(input.sessionId)
          break
        case 'stop':
          semanticDriver.assertObservation(reference)
          this.stop(input.sessionId)
          break
        case 'wait':
          semanticDriver.assertObservation(reference)
          await this.#waitForActionCondition(
            session,
            input.action,
            input.controlEpoch,
            reference,
          )
          break
        default:
          mayStartNavigation = input.action.kind === 'click'
            || input.action.kind === 'press'
            || input.action.kind === 'select'
          session.agentActionDepth += 1
          try {
            await semanticDriver.executeAction({
              action: input.action,
              documentRevision: input.documentRevision,
              ...(input.frameId ? { frameId: input.frameId } : {}),
              observationId: input.observationId,
            })
          }
          catch (error) {
            if (
              error instanceof SemanticBrowserDriverError
              && error.code === 'BROWSER_HUMAN_INPUT_REQUIRED'
            ) {
              this.#returnHumanControl(session, true)
            }
            throw error
          }
          finally {
            session.agentActionDepth -= 1
          }
          semanticDriver.invalidateDocument()
          session.refreshPageState()
          this.#publish(session)
      }

      await this.#waitForPostActionSettlement(session, mayStartNavigation)
      const observation = await this.observe({
        pageId: session.state.pageId,
        sessionId: session.state.sessionId,
      })
      return {
        actionKind: input.action.kind,
        observation,
        state: snapshot(session.state),
      }
    }
    finally {
      releaseQueue()
    }
  }

  readScreenshot(input: BrowserScreenshotReadInput): SemanticBrowserScreenshot {
    const session = this.#requireSession(input.sessionId)
    if (session.state.pageId !== input.pageId) {
      throw new BrowserHostError(
        'BROWSER_TARGET_STALE',
        'Browser page identity changed before screenshot resolution',
      )
    }
    this.#sessions.touch(input.sessionId)
    return this.#requireSemanticDriver(session).resolveScreenshot(input)
  }

  async captureScreenshot(sessionId: string): Promise<BrowserPageScreenshot> {
    const session = this.#requireSession(sessionId)
    if (!session.state.visible)
      throw new BrowserHostError('BROWSER_PAGE_FAILED', 'Screenshots require a visible browser page')
    const page = await this.#waitForPage(session)
    this.#sessions.touch(sessionId)
    const screenshot = await session.runWhileActive(() => page.capturePage())
    return {
      bytes: screenshot.toPNG(),
      title: page.getTitle().slice(0, 512),
    }
  }

  async navigate(sessionId: string, rawUrl: string): Promise<DesktopBrowserState> {
    this.#operations.assertCanMutate()
    const session = this.#requireSession(sessionId)
    await this.#waitForPage(session)
    this.#operations.assertCanMutate()
    const navigationSequence = this.#beginPageAction(session)
    let url: string
    try {
      url = await session.securityPolicy?.authorizeNavigation(rawUrl) ?? ''
    }
    catch (error) {
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
      this.#publish(session)
      throw new BrowserHostError(error.code, error.message, error.reason)
    }
    if (!this.#shouldContinuePageAction(session, navigationSequence))
      return snapshot(session.state)

    return this.#loadPage(sessionId, session, navigationSequence, url)
  }

  async #loadPage(
    sessionId: string,
    session: BrowserPageSession,
    navigationSequence: number,
    url: string,
  ): Promise<DesktopBrowserState> {
    session.state.url = url
    this.#publish(session)
    try {
      const page = await this.#waitForPage(session)
      await page.loadURL(url)
      if (!this.#sessions.get(sessionId))
        throw this.#sessionNotFound(sessionId)
      if (!this.#isCurrentPageAction(session, navigationSequence))
        return snapshot(session.state)
      session.stoppedNavigationSequence = null
      this.#finishPageAction(session, navigationSequence)
      session.removeBootstrapHistory()
      session.refreshPageState()
      session.state.status = 'ready'
      this.#publish(session)
      return snapshot(session.state)
    }
    catch (error) {
      if (error instanceof BrowserHostError)
        throw error
      if (!this.#sessions.get(sessionId))
        throw this.#sessionNotFound(sessionId)
      if (!this.#isCurrentPageAction(session, navigationSequence))
        return snapshot(session.state)
      if (session.stoppedNavigationSequence === navigationSequence) {
        session.stoppedNavigationSequence = null
        this.#finishPageAction(session, navigationSequence)
        session.state.error = null
        session.state.status = session.state.url === 'about:blank' ? 'idle' : 'ready'
        session.refreshPageState()
        this.#publish(session)
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
      if (this.#sessions.get(sessionId) !== session)
        throw this.#sessionNotFound(sessionId)
      if (!this.#isCurrentPageAction(session, navigationSequence))
        return snapshot(session.state)
      if (session.stoppedNavigationSequence === navigationSequence) {
        session.stoppedNavigationSequence = null
        this.#finishPageAction(session, navigationSequence)
        session.state.error = null
        session.state.status = session.state.url === 'about:blank' ? 'idle' : 'ready'
        session.refreshPageState()
        this.#publish(session)
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
        this.#publish(session)
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
        this.#publish(session)
        throw new BrowserHostError('BROWSER_PAGE_FAILED', message)
      }
      await wait(Math.min(remainingMs, 50))
    }
  }

  goBack(sessionId: string): void {
    this.#operations.assertCanMutate()
    const session = this.#requireSession(sessionId)
    const history = session.requirePage().navigationHistory
    if (!history.canGoBack())
      return
    this.#beginPageAction(session)
    history.goBack()
  }

  goForward(sessionId: string): void {
    this.#operations.assertCanMutate()
    const session = this.#requireSession(sessionId)
    const history = session.requirePage().navigationHistory
    if (!history.canGoForward())
      return
    this.#beginPageAction(session)
    history.goForward()
  }

  reload(sessionId: string): void {
    this.#operations.assertCanMutate()
    const session = this.#requireSession(sessionId)
    if (session.state.url === 'about:blank')
      return
    this.#beginPageAction(session)
    session.requirePage().reload()
  }

  stop(sessionId: string): void {
    const session = this.#requireSession(sessionId)
    if (session.state.status !== 'loading')
      return
    session.stoppedNavigationSequence = session.navigationSequence
    this.#finishPageAction(session, session.navigationSequence)
    session.requirePage().stop()
    session.refreshPageState()
    session.state.error = null
    session.state.status = session.state.url === 'about:blank' ? 'idle' : 'ready'
    this.#publish(session)
  }

  async openLocalFile(
    sessionId: string,
    grant: BrowserLocalFileGrant,
  ): Promise<DesktopBrowserState> {
    this.#operations.assertCanMutate()
    const session = this.#requireSession(sessionId)
    await this.#waitForPage(session)
    this.#operations.assertCanMutate()
    const navigationSequence = this.#beginPageAction(session)
    let url: string
    try {
      url = await session.securityPolicy?.authorizeLocalFile(
        grant.entryPath,
        grant.rootPath,
      ) ?? ''
    }
    catch (error) {
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
      this.#publish(session)
      throw new BrowserHostError(error.code, error.message, error.reason)
    }
    if (!this.#shouldContinuePageAction(session, navigationSequence))
      return snapshot(session.state)
    return this.#loadPage(sessionId, session, navigationSequence, url)
  }

  async #replaceSessionProfile(
    current: BrowserPageSession,
    profileMode: DesktopBrowserProfileMode,
  ): Promise<DesktopBrowserState> {
    const conversationId = current.state.conversationId
    const restoreVisibility = current.state.visible
    const restoreUrl = current.state.url.startsWith('file:') ? null : current.state.url
    const tabId = this.#sessions.getTabId(current.state.sessionId)
    this.#sessions.remove(current.state.sessionId)

    const state = this.#ensureSession(conversationId, profileMode, tabId)
    if (restoreVisibility) {
      this.setSurface({
        sessionId: state.sessionId,
        visible: true,
      })
    }
    if (restoreUrl && restoreUrl !== 'about:blank') {
      try {
        await this.navigate(state.sessionId, restoreUrl)
      }
      catch (error) {
        if (!(error instanceof BrowserHostError))
          throw error
      }
    }
    return this.getState(state.sessionId)
  }

  setSurface(input: DesktopBrowserSetSurfaceInput): void {
    if (!input.visible && !this.#sessions.get(input.sessionId))
      return
    const session = this.#requireSession(input.sessionId)
    if (!input.visible) {
      this.#hide(session)
      return
    }

    for (const other of this.#sessions.values()) {
      if (other !== session)
        this.#hide(other)
    }
    this.#sessions.setProtected(session.state.sessionId, 'surface', true)
    if (!session.state.visible) {
      session.state.visible = true
      session.markActive()
      this.#publish(session)
    }
  }

  async #waitForActionCondition(
    session: BrowserPageSession,
    action: BrowserWaitAction,
    controlEpoch: number,
    reference: { documentRevision: number, observationId: string },
  ): Promise<void> {
    const satisfied = await this.#pollWaitCondition(session, action, {
      controlEpoch,
      reference,
    })
    if (!satisfied) {
      throw new BrowserHostError(
        'BROWSER_PAGE_FAILED',
        'Browser wait condition timed out',
      )
    }
  }

  async waitFor(sessionId: string, spec: BrowserWaitSpec): Promise<BrowserWaitOutcome> {
    const session = this.#requireSession(sessionId)
    await this.#waitForPage(session)
    const startedAt = Date.now()
    const satisfied = await session.runWhileActive(() => this.#pollWaitCondition(session, spec, {}))
    return {
      condition: spec.condition,
      elapsedMs: Date.now() - startedAt,
      satisfied,
    }
  }

  async #pollWaitCondition(
    session: BrowserPageSession,
    spec: BrowserWaitRequest,
    options: {
      controlEpoch?: number
      reference?: { documentRevision: number, observationId: string }
    },
  ): Promise<boolean> {
    const initialUrl = session.state.url
    const deadline = Date.now() + spec.timeoutMs
    const usesProbe = spec.condition === 'text-visible'
      || spec.condition === 'ref-visible'
      || spec.condition === 'ref-hidden'
      || spec.condition === 'dom-stable'
    const stability = { lastFingerprint: null as string | null, stableSince: null as number | null }
    while (true) {
      if (this.#sessions.get(session.state.sessionId) !== session)
        throw this.#sessionNotFound(session.state.sessionId)
      if (options.controlEpoch !== undefined)
        this.#assertAgentControl(session, options.controlEpoch)
      if (session.state.status === 'error' && session.state.error) {
        throw new BrowserHostError(
          session.state.error.code,
          session.state.error.message,
          session.state.error.reason ?? null,
        )
      }
      if (await this.#evaluateWaitCondition(session, spec, initialUrl, options.reference, stability))
        return true
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0)
        return false
      await wait(Math.min(
        remainingMs,
        usesProbe ? BROWSER_WAIT_PROBE_INTERVAL_MS : BROWSER_WAIT_STATE_INTERVAL_MS,
      ))
    }
  }

  async #evaluateWaitCondition(
    session: BrowserPageSession,
    spec: BrowserWaitRequest,
    initialUrl: string,
    reference: { documentRevision: number, observationId: string } | undefined,
    stability: { lastFingerprint: string | null, stableSince: number | null },
  ): Promise<boolean> {
    switch (spec.condition) {
      case 'page-ready':
        return session.state.status === 'ready'
      case 'url-changed':
        return session.state.url !== initialUrl
      case 'url-matches':
        return session.state.url.includes(spec.pattern)
      case 'text-visible': {
        if (session.state.status === 'loading')
          return false
        const driver = this.#requireSemanticDriver(session)
        return driver.isTextVisible(spec.text).catch(swallowDriverProbeFailure)
      }
      case 'ref-visible':
      case 'ref-hidden': {
        if (!reference)
          throw new BrowserHostError('BROWSER_TARGET_STALE', 'Browser wait target requires an observation')
        const driver = this.#requireSemanticDriver(session)
        const visible = await driver.isTargetVisible({ ...reference, ref: spec.ref })
        return spec.condition === 'ref-visible' ? visible : !visible
      }
      case 'dom-stable': {
        if (session.state.status === 'loading') {
          stability.lastFingerprint = null
          stability.stableSince = null
          return false
        }
        const driver = this.#requireSemanticDriver(session)
        const fingerprint = await driver.fingerprintDocument().catch(() => null)
        const now = Date.now()
        if (fingerprint === null || fingerprint !== stability.lastFingerprint) {
          stability.lastFingerprint = fingerprint
          stability.stableSince = fingerprint === null ? null : now
          return false
        }
        return stability.stableSince !== null
          && now - stability.stableSince >= (spec.quietMs ?? BROWSER_WAIT_DEFAULT_QUIET_MS)
      }
    }
  }

  async #waitForPostActionSettlement(
    session: BrowserPageSession,
    detectNavigation: boolean,
  ): Promise<void> {
    if (detectNavigation)
      await wait(BROWSER_ACTION_NAVIGATION_DETECTION_MS)
    const deadline = Date.now() + BROWSER_NAVIGATION_SETTLE_TIMEOUT_MS
    while (session.state.status === 'loading') {
      if (this.#sessions.get(session.state.sessionId) !== session)
        throw this.#sessionNotFound(session.state.sessionId)
      if (session.state.error) {
        throw new BrowserHostError(
          session.state.error.code,
          session.state.error.message,
          session.state.error.reason ?? null,
        )
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        throw new BrowserHostError(
          'BROWSER_PAGE_FAILED',
          'Browser action navigation did not settle',
        )
      }
      await wait(Math.min(remainingMs, 50))
    }
  }

  close(sessionId: string): void {
    this.#requireSession(sessionId)
    this.#sessions.remove(sessionId)
  }

  releaseRuntimeControl(): void {
    if (this.#disposed)
      return
    for (const session of this.#sessions.values()) {
      if (session.state.controller === 'agent')
        this.#returnHumanControl(session, true)
    }
  }

  dispose(): void {
    if (this.#disposed)
      return
    this.#disposed = true
    this.#window.off('closed', this.#windowClosedListener)
    this.#window.webContents.off('will-attach-webview', this.#willAttachWebviewListener)
    this.#sessions.dispose()
    this.#evictedConversationIds.clear()
  }

  #assertActive(): void {
    if (this.#disposed)
      throw new BrowserHostError('BROWSER_SESSION_NOT_FOUND', 'Browser host is disposed')
  }

  #createSession(
    conversationId: string | null,
    sessionId: string,
    profileMode: DesktopBrowserProfileMode,
  ): BrowserPageSession {
    const descriptor: DesktopBrowserGuestDescriptor = {
      partition: profileMode === 'default'
        ? BROWSER_DEFAULT_PARTITION
        : `buddy-browser-incognito:${sessionId}`,
      sessionId,
    }
    const session: BrowserPageSession = new BrowserPageSession({
      getFreezeDelay: this.#getFreezeDelay,
      onActivityError: this.#onActivityError,
      descriptor,
      createId: this.#createId,
      getDefaultZoomFactor: this.#getDefaultZoomFactor,
      operations: this.#operations,
      onStateChanged: this.#onStateChanged,
      onGuestSetChanged: this.#onGuestSetChanged,
      onHumanInput: () => this.#acceptHumanPageInput(session),
      isCurrent: () => this.#sessions.get(sessionId) === session,
      state: {
        zoomFactor: this.#getDefaultZoomFactor(),
        canGoBack: false,
        canGoForward: false,
        controller: 'human',
        controlEpoch: 0,
        conversationId,
        error: null,
        pageId: this.#createId(),
        profileMode,
        sessionId,
        status: 'idle',
        title: '',
        url: 'about:blank',
        visible: false,
      },
    })
    const page = this.#createPage?.(descriptor)
    if (page)
      session.attach(page)
    return session
  }

  #teardownSession(
    session: BrowserPageSession,
    reason: BrowserSessionTeardownReason,
  ): void {
    if (reason === 'evicted') {
      if (session.state.conversationId)
        this.#evictedConversationIds.add(session.state.conversationId)
      session.state.error = {
        code: 'BROWSER_SESSION_EVICTED',
        message: 'Inactive browser session was released',
      }
      session.state.status = 'error'
      this.#publish(session)
    }
    session.state.visible = false
    this.#onSessionClosed(snapshot(session.state), reason)
    const page = session.page
    session.releasePage()
    session.pageReady.reject(this.#sessionNotFound(session.state.sessionId))
    if (page && !page.isDestroyed())
      page.close()
    this.#onGuestSetChanged()
  }

  #hide(session: BrowserPageSession): void {
    this.#sessions.setProtected(session.state.sessionId, 'surface', false)
    if (session.state.visible) {
      session.state.visible = false
      session.markActive()
      this.#publish(session)
    }
  }

  #beginPageAction(session: BrowserPageSession): number {
    this.#sessions.touch(session.state.sessionId)
    session.navigationSequence += 1
    session.activeNavigationSequence = session.navigationSequence
    session.semanticDriver?.invalidateDocument()
    session.stoppedNavigationSequence = null
    session.state.error = null
    session.state.status = 'loading'
    this.#publish(session)
    return session.navigationSequence
  }

  #isCurrentPageAction(session: BrowserPageSession, navigationSequence: number): boolean {
    return session.navigationSequence === navigationSequence
  }

  #finishPageAction(session: BrowserPageSession, navigationSequence: number): void {
    if (session.activeNavigationSequence === navigationSequence)
      session.activeNavigationSequence = null
  }

  #shouldContinuePageAction(session: BrowserPageSession, navigationSequence: number): boolean {
    return this.#isCurrentPageAction(session, navigationSequence)
      && session.stoppedNavigationSequence !== navigationSequence
  }

  #publish(session: BrowserPageSession): void {
    session.publish()
  }

  #assertCurrentPage(
    session: BrowserPageSession,
    pageId: string,
    operation: string,
  ): void {
    if (session.state.pageId === pageId)
      return
    throw new BrowserHostError(
      'BROWSER_TARGET_STALE',
      `Browser page identity changed ${operation}`,
    )
  }

  #assertAgentControl(session: BrowserPageSession, controlEpoch: number): void {
    if (
      session.state.controller === 'agent'
      && session.state.controlEpoch === controlEpoch
    ) {
      return
    }
    throw new BrowserHostError(
      'BROWSER_CONTROL_REQUIRED',
      'Browser agent control is required',
    )
  }

  #advanceControlEpoch(session: BrowserPageSession): void {
    if (session.state.controlEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new BrowserHostError(
        'BROWSER_PAGE_FAILED',
        'Browser control epoch is exhausted',
      )
    }
    session.state.controlEpoch += 1
  }

  #acceptHumanPageInput(session: BrowserPageSession): void {
    if (!session.state.visible)
      return
    this.#sessions.touch(session.state.sessionId)
    if (session.state.controller === 'agent') {
      this.#returnHumanControl(session, true)
      return
    }
    session.semanticDriver?.invalidateDocument()
  }

  #returnHumanControl(
    session: BrowserPageSession,
    invalidateObservation = false,
  ): DesktopBrowserState {
    this.#advanceControlEpoch(session)
    session.state.controller = 'human'
    if (invalidateObservation)
      session.semanticDriver?.invalidateDocument()
    this.#sessions.setProtected(session.state.sessionId, 'runtime', false)
    this.#publish(session)
    return snapshot(session.state)
  }

  #configureGuestAttachment(
    event: ElectronEvent,
    webPreferences: WebPreferences,
    params: Record<string, string>,
  ): void {
    const descriptor = this.#sessions.values().find(candidate => (
      candidate.descriptor.partition === params.partition
    ))?.descriptor
    if (!descriptor || params.src !== 'about:blank') {
      event.preventDefault()
      return
    }

    delete params.allowpopups
    delete params.preload
    delete webPreferences.preload
    Object.assign(webPreferences, {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      partition: descriptor.partition,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    } satisfies WebPreferences)
  }

  #requireSemanticDriver(session: BrowserPageSession): SemanticBrowserDriver {
    const driver = session.semanticDriver
    if (!driver) {
      throw new BrowserHostError(
        'BROWSER_PAGE_FAILED',
        'Browser guest is not attached',
      )
    }
    return driver
  }

  async #waitForPage(session: BrowserPageSession): Promise<BrowserPage> {
    const page = session.page
    if (page && !page.isDestroyed()) {
      await session.resumePage()
      return page
    }
    this.#onGuestSetChanged()
    const attached = await waitForBrowserPage(session.pageReady.promise)
    await session.resumePage()
    return attached
  }

  #requireSession(sessionId: string): BrowserPageSession {
    this.#assertActive()
    const session = this.#sessions.get(sessionId)
    if (!session)
      throw this.#sessionNotFound(sessionId)
    return session
  }

  #sessionNotFound(sessionId: string): BrowserHostError {
    return new BrowserHostError(
      'BROWSER_SESSION_NOT_FOUND',
      `Browser session is unavailable: ${sessionId}`,
    )
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

function swallowDriverProbeFailure(error: unknown): false {
  if (error instanceof SemanticBrowserDriverError && error.code === 'BROWSER_PAGE_FAILED')
    return false
  throw error
}

function waitForBrowserPage(promise: Promise<BrowserPage>): Promise<BrowserPage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new BrowserHostError(
        'BROWSER_PAGE_FAILED',
        'Browser guest did not attach to the Desktop renderer',
      ))
    }, BROWSER_GUEST_ATTACH_TIMEOUT_MS)
    void promise.then((page) => {
      clearTimeout(timeout)
      resolve(page)
    }, (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

function wait(durationMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, durationMs))
}

export { BrowserHostError } from './BrowserHostError'
