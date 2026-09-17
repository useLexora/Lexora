import type { Input, MouseInputEvent, WebContents } from 'electron'
import type { EventEmitter } from 'node:events'
import type { BrowserErrorCode } from '../../../shared/browser'
import type { DesktopBrowserError, DesktopBrowserGuestDescriptor, DesktopBrowserProfileMode, DesktopBrowserState } from '../../../shared/browser/browserDesktopApi'
import type { BrowserOperationGuard } from './BrowserOperationGuard'
import type { BrowserSecurityPage, BrowserSecuritySession } from './BrowserSecurityPolicy'
import { browserZoomFactorSchema, stepBrowserZoom } from '../../../shared/browser/browserPreferences'
import { BrowserDebugger } from './BrowserDebugger'
import { BrowserHostError } from './BrowserHostError'
import { BrowserPageActivity } from './BrowserPageActivity'
import { BrowserSecurityPolicy, isLoopbackBrowserUrl } from './BrowserSecurityPolicy'
import { SemanticBrowserDriver } from './SemanticBrowserDriver'

export interface BrowserPage extends BrowserSecurityPage {
  isCurrentlyAudible: () => boolean
  getBackgroundThrottling: () => boolean
  setBackgroundThrottling: (allowed: boolean) => void
  getZoomFactor: () => number
  setZoomFactor: (factor: number) => void
  setZoomMode: (mode: 'isolated') => void
  capturePage: () => Promise<{
    getSize: () => { height: number, width: number }
    toPNG: () => Uint8Array
  }>
  close: () => void
  focus: () => void
  getTitle: () => string
  getURL: () => string
  isDestroyed: () => boolean
  loadURL: (url: string) => Promise<unknown>
  navigationHistory: {
    canGoBack: () => boolean
    canGoForward: () => boolean
    getActiveIndex: () => number
    getEntryAtIndex: (index: number) => { url: string } | null
    goBack: () => void
    goForward: () => void
    removeEntryAtIndex: (index: number) => boolean
  }
  off: WebContents['off']
  on: WebContents['on']
  reload: () => void
  session: BrowserSecuritySession
  stop: () => void
}

export interface BrowserSessionState {
  zoomFactor: number
  canGoBack: boolean
  canGoForward: boolean
  controller: 'human' | 'agent'
  controlEpoch: number
  conversationId: string | null
  error: DesktopBrowserError | null
  pageId: string
  profileMode: DesktopBrowserProfileMode
  sessionId: string
  status: 'error' | 'idle' | 'loading' | 'ready'
  title: string
  url: string
  visible: boolean
}

interface BrowserPageDeferred {
  promise: Promise<BrowserPage>
  reject: (error: Error) => void
  resolve: (page: BrowserPage) => void
}

interface BrowserPageSessionOptions {
  getFreezeDelay: (visible: boolean) => number | null
  onActivityError: () => void
  createId: () => string
  descriptor: DesktopBrowserGuestDescriptor
  getDefaultZoomFactor: () => number
  onGuestSetChanged: () => void
  onHumanInput: () => void
  onStateChanged: (state: DesktopBrowserState) => void
  isCurrent: () => boolean
  operations: BrowserOperationGuard
  state: BrowserSessionState
}

export class BrowserPageSession {
  actionTail = Promise.resolve()
  activeNavigationSequence: number | null = null
  agentActionDepth = 0
  readonly descriptor: DesktopBrowserGuestDescriptor
  #listeners: Array<() => void> = []
  mainFrameCommitSequence: number | null = null
  navigationSequence = 0
  page: BrowserPage | null = null
  #connection: BrowserDebugger | null = null
  #activity: BrowserPageActivity | null = null
  pageReady = createBrowserPageDeferred()
  securityPolicy: BrowserSecurityPolicy | null = null
  semanticDriver: SemanticBrowserDriver | null = null
  shouldClearBootstrapHistory = true
  readonly state: BrowserSessionState
  stoppedNavigationSequence: number | null = null
  readonly #options: BrowserPageSessionOptions

  constructor(options: BrowserPageSessionOptions) {
    this.#options = options
    this.state = options.state
    this.descriptor = options.descriptor
  }

  async setZoomFactor(factor: number | null): Promise<DesktopBrowserState> {
    this.#options.operations.assertCanMutate()
    const page = this.requirePage()
    page.setZoomFactor(browserZoomFactorSchema.parse(factor ?? this.#options.getDefaultZoomFactor()))
    this.state.zoomFactor = page.getZoomFactor()
    this.semanticDriver?.invalidateDocument()
    this.publish()
    return snapshot(this.state)
  }

  publish(): void {
    void this.updateActivity().catch(this.#options.onActivityError)
    this.#options.onStateChanged(snapshot(this.state))
  }

  updateActivity(): Promise<void> {
    return this.#activity?.update() ?? Promise.resolve()
  }

  markActive(): void {
    void this.#activity?.markActive().catch(this.#options.onActivityError)
  }

  resumePage(): Promise<void> {
    return this.#activity?.resume() ?? Promise.resolve()
  }

  runWhileActive<T>(operation: () => Promise<T>): Promise<T> {
    return this.#activity?.run(operation) ?? operation()
  }

  attach(page: BrowserPage): void {
    this.page = page
    this.#connection = new BrowserDebugger(page.debugger)
    this.#activity = new BrowserPageActivity({
      connection: this.#connection,
      getFreezeDelay: () => this.state.controller === 'human'
        && this.state.status !== 'loading'
        && this.agentActionDepth === 0
        && !page.isDestroyed()
        && !page.isCurrentlyAudible()
        ? this.#options.getFreezeDelay(this.state.visible)
        : null,
      onError: this.#options.onActivityError,
      onResumed: () => {
        // CDP 恢复执行后原生视图仍可能隐藏，重应用原节流策略以恢复绘制。
        if (!page.isDestroyed())
          page.setBackgroundThrottling(page.getBackgroundThrottling())
      },
    })
    page.setZoomMode('isolated')
    page.setZoomFactor(this.state.zoomFactor)
    this.semanticDriver = new SemanticBrowserDriver({
      connection: this.#connection,
      createId: this.#options.createId,
      page,
    })
    this.securityPolicy = new BrowserSecurityPolicy({
      connection: this.#connection,
      onCertificateError: ({ error, url }) => {
        this.state.error = {
          code: 'BROWSER_CERTIFICATE_ERROR',
          message: error,
        }
        this.state.status = 'error'
        this.state.url = normalizeBrowserUrl(url) ?? this.state.url
        this.publish()
      },
      onPermissionDenied: () => {
        this.state.error = {
          code: 'BROWSER_PERMISSION_DENIED',
          message: 'Browser permission request was denied',
        }
        this.publish()
      },
      onRequestBlocked: (details) => {
        if (details.resourceType !== 'mainFrame')
          return
        this.state.error = {
          code: 'BROWSER_NAVIGATION_BLOCKED',
          message: 'Browser navigation was blocked by network policy',
          reason: 'NETWORK_POLICY_BLOCKED',
        }
        this.state.status = 'error'
        this.publish()
      },
      page,
      session: page.session,
    })
    this.#configureSession(page)
    this.pageReady.resolve(page)
    this.refreshPageState()
    this.publish()
  }

  #onHumanInput(): void {
    this.markActive()
    this.#options.onHumanInput()
  }

  #configureSession(page: BrowserPage): void {
    this.#listen(page, 'audio-state-changed', () => {
      void this.updateActivity().catch(this.#options.onActivityError)
    })
    this.#listen(page, 'zoom-changed', (_event: unknown, direction: 'in' | 'out') => {
      if (this.agentActionDepth > 0)
        return
      this.#onHumanInput()
      void this.setZoomFactor(stepBrowserZoom(page.getZoomFactor(), direction)).catch(() => {})
    })
    this.#listen(
      page,
      'before-input-event',
      (event: { preventDefault: () => void }, input: Input) => {
        if (this.agentActionDepth > 0)
          return
        if ((input.type === 'keyDown' || input.type === 'rawKeyDown') && (input.control || input.meta) && !input.alt && ['+', '=', '-', '0'].includes(input.key)) {
          event.preventDefault()
          this.#onHumanInput()
          const factor = input.key === '0' ? null : stepBrowserZoom(page.getZoomFactor(), input.key === '-' ? 'out' : 'in')
          void this.setZoomFactor(factor).catch(() => {})
          return
        }
        if (input.type === 'keyDown' || input.type === 'rawKeyDown')
          this.#onHumanInput()
      },
    )
    this.#listen(
      page,
      'before-mouse-event',
      (_event: unknown, input: MouseInputEvent) => {
        if (this.agentActionDepth === 0 && input.type === 'mouseMove')
          this.markActive()
        if (
          this.agentActionDepth === 0
          && ['contextMenu', 'mouseDown', 'mouseWheel'].includes(input.type)
        ) {
          this.#onHumanInput()
        }
      },
    )
    this.#listen(page, 'did-start-loading', () => {
      const isIndependentNavigation = this.activeNavigationSequence === null
      if (isIndependentNavigation) {
        this.navigationSequence += 1
        this.activeNavigationSequence = this.navigationSequence
        this.semanticDriver?.invalidateDocument()
        this.stoppedNavigationSequence = null
      }
      if (isIndependentNavigation)
        this.state.error = null
      if (!this.state.error)
        this.state.status = 'loading'
      this.refreshPageState()
      this.publish()
    })
    this.#listen(page, 'did-stop-loading', () => {
      this.removeBootstrapHistory()
      const isPreparingInitialNavigation = this.state.status === 'loading'
        && this.state.url === 'about:blank'
      if (
        !isPreparingInitialNavigation
        && (!this.state.error || this.state.error.code === 'BROWSER_PERMISSION_DENIED')
      ) {
        this.state.status = this.state.url === 'about:blank' ? 'idle' : 'ready'
      }
      if (!isPreparingInitialNavigation)
        this.activeNavigationSequence = null
      this.refreshPageState()
      this.publish()
    })
    this.#listen(page, 'page-title-updated', (_event, title: string) => {
      this.state.title = title.slice(0, 512)
      this.publish()
    })
    const updateNavigation = (_event: unknown, url: string) => {
      const normalizedUrl = normalizeBrowserUrl(url)
      if (!normalizedUrl)
        return
      this.mainFrameCommitSequence = this.navigationSequence
      this.refreshPageState()
      this.state.url = normalizedUrl
      if (this.state.error?.code === 'BROWSER_PAGE_FAILED') {
        this.state.error = null
        this.state.status = 'loading'
      }
      this.publish()
    }
    this.#listen(page, 'did-navigate', updateNavigation)
    this.#listen(
      page,
      'did-frame-navigate',
      (
        _event: unknown,
        _url: string,
        _httpResponseCode: number,
        _httpStatusText: string,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame)
          return
        this.semanticDriver?.invalidateDocument()
        this.publish()
      },
    )
    this.#listen(
      page,
      'did-navigate-in-page',
      (_event: unknown, url: string, isMainFrame: boolean) => {
        this.semanticDriver?.invalidateDocument()
        if (isMainFrame)
          updateNavigation(_event, url)
        else
          this.publish()
      },
    )
    const blockUnsafeNavigation = (event: { preventDefault: () => void }, url: string) => {
      if (normalizeBrowserUrl(url))
        return
      event.preventDefault()
      this.state.error = {
        code: 'BROWSER_NAVIGATION_BLOCKED',
        message: 'Browser navigation only supports HTTP, HTTPS, and authorized local files',
        reason: 'UNSUPPORTED_PROTOCOL',
      }
      this.state.status = 'error'
      this.publish()
    }
    this.#listen(page, 'will-navigate', blockUnsafeNavigation)
    this.#listen(page, 'will-redirect', blockUnsafeNavigation)
    this.#listen(
      page,
      'did-fail-load',
      (
        _event,
        errorCode: number,
        errorDescription: string,
        validatedUrl: string,
        isMainFrame: boolean,
      ) => {
        if (!isMainFrame || errorCode === -3)
          return
        if (this.state.error?.code === 'BROWSER_CERTIFICATE_ERROR')
          return
        const failedUrl = normalizeBrowserUrl(validatedUrl)
        if (
          failedUrl
          && this.state.url !== 'about:blank'
          && this.state.url !== failedUrl
        ) {
          return
        }
        this.state.error = {
          code: 'BROWSER_PAGE_FAILED',
          message: errorDescription.slice(0, 1_024),
        }
        this.state.status = 'error'
        this.state.url = failedUrl ?? this.state.url
        this.publish()
      },
    )
    this.#listen(page, 'render-process-gone', () => {
      this.semanticDriver?.invalidateDocument()
      this.state.error = {
        code: 'BROWSER_PAGE_CRASHED',
        message: 'Browser page renderer exited',
      }
      this.state.status = 'error'
      this.publish()
    })
    this.#listen(page, 'unresponsive', () => {
      this.state.error = {
        code: 'BROWSER_PAGE_UNRESPONSIVE',
        message: 'Browser page is not responding',
      }
      this.state.status = 'error'
      this.publish()
    })
    this.#listen(page, 'responsive', () => {
      if (this.state.error?.code !== 'BROWSER_PAGE_UNRESPONSIVE')
        return
      this.state.error = null
      this.state.status = 'ready'
      this.refreshPageState()
      this.publish()
    })
    this.#listen(page, 'destroyed', () => {
      if (!this.#options.isCurrent() || this.page !== page)
        return
      this.releasePage()
      this.pageReady = createBrowserPageDeferred()
      this.shouldClearBootstrapHistory = true
      this.state.canGoBack = false
      this.state.canGoForward = false
      this.state.error = {
        code: 'BROWSER_PAGE_CRASHED',
        message: 'Browser guest was detached from the Desktop renderer',
      }
      this.state.pageId = this.#options.createId()
      this.state.status = 'error'
      this.state.title = ''
      this.state.url = 'about:blank'
      this.publish()
      this.#options.onGuestSetChanged()
    })
  }

  #listen<Args extends unknown[]>(
    page: BrowserPage,
    event: string,
    listener: (...args: Args) => void,
  ): void {
    const emitter = page as Pick<EventEmitter, 'on' | 'off'>
    emitter.on(event, listener)
    this.#listeners.push(() => emitter.off(event, listener))
  }

  removeBootstrapHistory(): void {
    if (!this.shouldClearBootstrapHistory)
      return
    const page = this.page
    if (!page || page.isDestroyed())
      return
    const history = page.navigationHistory
    const firstEntry = history.getEntryAtIndex(0)
    if (!firstEntry)
      return
    if (firstEntry.url !== 'about:blank') {
      this.shouldClearBootstrapHistory = false
      return
    }
    if (history.getActiveIndex() > 0 && history.removeEntryAtIndex(0))
      this.shouldClearBootstrapHistory = false
  }

  refreshPageState(): void {
    const page = this.page
    if (!page || page.isDestroyed())
      return
    this.state.canGoBack = page.navigationHistory.canGoBack()
    this.state.canGoForward = page.navigationHistory.canGoForward()
    this.state.title = page.getTitle().slice(0, 512)
    this.state.zoomFactor = page.getZoomFactor()
    const pageUrl = page.getURL()
    const normalizedPageUrl = normalizeBrowserUrl(pageUrl)
    if (normalizedPageUrl)
      this.state.url = normalizedPageUrl
  }

  releasePage(): void {
    this.#activity?.dispose()
    this.#activity = null
    try {
      this.securityPolicy?.dispose()
    }
    catch {}
    this.securityPolicy = null
    try {
      this.semanticDriver?.dispose()
    }
    catch {}
    this.semanticDriver = null
    try {
      this.#connection?.dispose()
    }
    catch {}
    this.#connection = null
    for (const removeListener of this.#listeners) {
      try {
        removeListener()
      }
      catch {}
    }
    this.#listeners = []
    this.page = null
  }

  requirePage(): BrowserPage {
    const page = this.page
    if (!page || page.isDestroyed()) {
      throw new BrowserHostError(
        'BROWSER_PAGE_FAILED',
        'Browser guest is not attached',
      )
    }
    return page
  }
}

function normalizeBrowserUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (!['file:', 'http:', 'https:'].includes(url.protocol))
      return null
    return url.toString()
  }
  catch {
    return null
  }
}

export function snapshot(state: BrowserSessionState): DesktopBrowserState {
  return {
    ...state,
    error: state.error ? { ...state.error } : null,
    security: projectSecurityState(state.url, state.error?.code),
  }
}

function projectSecurityState(
  rawUrl: string,
  errorCode: BrowserErrorCode | undefined,
): DesktopBrowserState['security'] {
  if (rawUrl === 'about:blank')
    return { kind: 'blank', origin: null }
  const url = new URL(rawUrl)
  const origin = url.origin
  if (errorCode === 'BROWSER_CERTIFICATE_ERROR')
    return { kind: 'certificate-error', origin }
  if (url.protocol === 'file:')
    return { kind: 'local', origin: 'file://' }
  if (isLoopbackBrowserUrl(rawUrl))
    return { kind: 'local', origin }
  return {
    kind: url.protocol === 'https:' ? 'secure' : 'insecure',
    origin,
  }
}

function createBrowserPageDeferred(): BrowserPageDeferred {
  let reject!: (error: Error) => void
  let resolve!: (page: BrowserPage) => void
  const promise = new Promise<BrowserPage>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  void promise.catch(() => {})
  return { promise, reject, resolve }
}
