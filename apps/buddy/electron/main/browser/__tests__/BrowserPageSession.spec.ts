import type { BrowserPage } from '../BrowserPageSession'
import type { BrowserSecuritySession } from '../BrowserSecurityPolicy'
import { EventEmitter } from 'node:events'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserHostError } from '../BrowserHostError'
import { BrowserOperationGuard } from '../BrowserOperationGuard'
import { BrowserPageSession } from '../BrowserPageSession'

type BeforeRequestListener = NonNullable<Parameters<BrowserSecuritySession['webRequest']['onBeforeRequest']>[1]>
type HeadersReceivedListener = NonNullable<Parameters<BrowserSecuritySession['webRequest']['onHeadersReceived']>[0]>

class NetworkSession extends EventEmitter implements BrowserSecuritySession {
  beforeRequest: BeforeRequestListener | null = null
  headersReceived: HeadersReceivedListener | null = null
  permissionCheck: Parameters<BrowserSecuritySession['setPermissionCheckHandler']>[0] = null
  permissionRequest: Parameters<BrowserSecuritySession['setPermissionRequestHandler']>[0] = null
  setPermissionCheckHandler = (handler: typeof this.permissionCheck) => { this.permissionCheck = handler }
  setPermissionRequestHandler = (handler: typeof this.permissionRequest) => { this.permissionRequest = handler }
  readonly webRequest = {
    onHeadersReceived: (listener: HeadersReceivedListener | null) => { this.headersReceived = listener },
    onBeforeRequest: (filter: { urls: string[] } | BeforeRequestListener | null, listener?: BeforeRequestListener | null) => {
      this.beforeRequest = typeof filter === 'function' ? filter : listener ?? null
    },
  }

  request(webContentsId: number, url = 'https://example.test/data', resourceType = 'xhr'): Promise<{ cancel: boolean }> {
    return new Promise((resolve) => {
      if (this.beforeRequest)
        this.beforeRequest({ webContentsId, url, resourceType }, resolve)
      else
        resolve({ cancel: false })
    })
  }

  receiveHeaders(webContentsId: number, download = false): Promise<{ cancel: boolean }> {
    return new Promise((resolve) => {
      if (this.headersReceived) {
        this.headersReceived({
          webContentsId,
          url: 'https://example.test/data',
          resourceType: 'xhr',
          responseHeaders: download ? { 'content-disposition': ['attachment; filename=test.txt'] } : {},
        }, resolve)
      }
      else {
        resolve({ cancel: false })
      }
    })
  }
}

class Guest extends EventEmitter {
  id = 1
  destroyed = false
  autoDestroy = true
  stopped = false
  closeRequested = false
  backgroundThrottling = true
  debuggerAttached = false
  zoom = 1
  url = 'https://example.test/'
  readonly debugger = Object.assign(new EventEmitter(), {
    attach: () => { this.debuggerAttached = true },
    detach: () => { this.debuggerAttached = false },
    isAttached: () => this.debuggerAttached,
    sendCommand: vi.fn(async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({})),
  })

  readonly session: NetworkSession

  constructor(session = new NetworkSession()) {
    super()
    this.session = session
  }

  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    getActiveIndex: () => 0,
    getEntryAtIndex: () => null,
    goBack: vi.fn(),
    goForward: vi.fn(),
    removeEntryAtIndex: () => false,
  }

  getURL = () => this.url
  getTitle = () => 'Page'
  isDestroyed = () => this.destroyed
  isCurrentlyAudible = () => false
  getBackgroundThrottling = () => this.backgroundThrottling
  setBackgroundThrottling = (allowed: boolean) => { this.backgroundThrottling = allowed }
  getZoomFactor = () => this.zoom
  setZoomFactor = (factor: number) => { this.zoom = factor }
  setZoomMode = vi.fn()
  setWindowOpenHandler = vi.fn()
  focus = vi.fn()
  insertText = vi.fn(async () => {})
  sendInputEvent = vi.fn()
  reload = vi.fn()
  stop = () => { this.stopped = true }
  capturePage = vi.fn(async () => ({ getSize: () => ({ width: 1, height: 1 }), toPNG: () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }))
  close = (options?: { waitForBeforeUnload: boolean }) => {
    expect(options).toEqual({ waitForBeforeUnload: false })
    this.closeRequested = true
    if (this.autoDestroy)
      this.destroy()
  }

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }

  asPage(): BrowserPage {
    return this as unknown as BrowserPage
  }
}

function fixture(guest = new Guest()) {
  let current = true
  let id = 0
  const errors: unknown[] = []
  const states: unknown[] = []
  const session = new BrowserPageSession({
    descriptor: { partition: 'persist:test-browser', sessionId: 'session' },
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    getDefaultZoomFactor: () => 1,
    getFreezeDelay: () => null,
    isCurrent: () => current,
    onActivityError: () => { errors.push('activity-error') },
    onGuestChanged: () => {},
    onHumanInput: () => {},
    onStateChanged: state => states.push(state),
    operations: new BrowserOperationGuard(),
    operationTimeoutMs: 30,
    cleanupTimeoutMs: 5,
    state: {
      canGoBack: false,
      canGoForward: false,
      controller: 'human',
      controlEpoch: 0,
      conversationId: 'conversation',
      error: null,
      pageId: 'page-0',
      profileMode: 'default',
      sessionId: 'session',
      status: 'ready',
      title: 'Page',
      url: guest.url,
      visible: true,
      zoomFactor: 1,
    },
  })
  session.attach(guest.asPage())
  return {
    errors,
    guest,
    session,
    states,
    retire: () => { current = false },
  }
}

describe('browser page session cleanup', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps drawing active until the last concurrent operation really completes', async () => {
    const { guest, session } = fixture()
    const first = deferred<number>()
    const second = deferred<number>()
    const a = session.runWhileActive(() => first.promise)
    const b = session.runWhileActive(() => second.promise)
    expect(guest.backgroundThrottling).toBe(false)
    first.resolve(1)
    await expect(a).resolves.toBe(1)
    expect(guest.backgroundThrottling).toBe(false)
    second.resolve(2)
    await expect(b).resolves.toBe(2)
    expect(guest.backgroundThrottling).toBe(true)
    await session.abortOperations()
    expect(session.requirePage()).toBe(guest)
    expect(guest.destroyed).toBe(false)
    session.releasePage()
    await session.whenIdle()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds an unresponsive operation and only destroys its owning guest', async () => {
    const { guest, session } = fixture()
    const other = fixture()
    const hang = deferred<never>()
    const operation = session.runWhileActive(() => hang.promise)
    const failure = expect(operation).rejects.toMatchObject({ code: 'BROWSER_PAGE_UNRESPONSIVE' })
    await vi.advanceTimersByTimeAsync(30)
    await failure
    expect(guest.stopped).toBe(true)
    expect(guest.destroyed).toBe(true)
    expect(session.page).toBeNull()
    expect(session.state.error?.code).toBe('BROWSER_PAGE_UNRESPONSIVE')
    expect(other.session.requirePage()).toBe(other.guest)
    expect(other.guest.stopped).toBe(false)
    expect(other.guest.destroyed).toBe(false)
    other.session.releasePage()
    await other.session.whenIdle()
  })

  it('does not release on detach or late success before destruction, and cannot revive an old page', async () => {
    const { guest, session } = fixture()
    guest.autoDestroy = false
    const raw = deferred<string>()
    const result = session.runWhileActive(() => raw.promise)
    const failure = expect(result).rejects.toMatchObject({ code: 'BROWSER_PAGE_UNRESPONSIVE' })
    let settled = false
    void result.catch(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(30)
    let idle = false
    void session.whenIdle().then(() => {
      idle = true
    })
    raw.resolve('late success')
    await Promise.resolve()
    expect(guest.closeRequested).toBe(true)
    expect(guest.destroyed).toBe(false)
    expect(guest.backgroundThrottling).toBe(false)
    expect(settled).toBe(false)
    expect(idle).toBe(false)
    expect(() => session.requirePage()).toThrow(BrowserHostError)
    expect(() => session.attach(new Guest().asPage())).toThrow(BrowserHostError)

    guest.destroy()
    await failure
    await session.whenIdle()
    expect(idle).toBe(true)
    const replacement = new Guest()
    session.attach(replacement.asPage())
    const state = { ...session.state }
    guest.emit('did-stop-loading')
    guest.emit('responsive')
    guest.emit('page-title-updated', {}, 'Stale title')
    expect(session.state).toEqual(state)
    expect(session.page).toBe(replacement)
    const next = deferred<void>()
    const active = session.runWhileActive(() => next.promise)
    expect(replacement.backgroundThrottling).toBe(false)
    next.resolve()
    await active
    expect(replacement.backgroundThrottling).toBe(true)
    session.releasePage()
    await session.whenIdle()
  })

  it('reports cleanup failure without releasing the operation or admitting a replacement guest', async () => {
    const { guest, session, errors } = fixture()
    guest.autoDestroy = false
    const operation = session.runWhileActive(() => new Promise<never>(() => {}))
    const failure = expect(operation).rejects.toMatchObject({ code: 'BROWSER_PAGE_FAILED' })
    let settled = false
    void operation.catch(() => {
      settled = true
    })
    const cleanup = session.abortOperations()
    const cleanupFailure = expect(cleanup).rejects.toMatchObject({ code: 'BROWSER_PAGE_UNRESPONSIVE' })
    await vi.advanceTimersByTimeAsync(5)
    await cleanupFailure
    expect(errors.length).toBeGreaterThan(0)
    expect(settled).toBe(false)
    expect(session.page).toBe(guest)
    expect(guest.backgroundThrottling).toBe(false)
    expect(() => session.attach(new Guest().asPage())).toThrow()
    guest.destroy()
    await session.whenIdle()
    await failure
    expect(session.page).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['pending', 'throws'] as const)('keeps network and security handlers fail-closed while close %s', async (closing) => {
    const { guest, session } = fixture()
    const network = guest.session
    guest.autoDestroy = false
    if (closing === 'throws') {
      guest.close = () => {
        throw new Error('close failed')
      }
    }
    await expect(network.request(guest.id)).resolves.toEqual({ cancel: false })
    const beforeRequest = network.beforeRequest
    const headersReceived = network.headersReceived
    const permissionCheck = network.permissionCheck
    const permissionRequest = network.permissionRequest
    session.releasePage()
    const cleanupFailure = expect(session.waitForCleanup()).rejects.toMatchObject({ code: 'BROWSER_PAGE_UNRESPONSIVE' })
    session.networkAuthorization.useHumanControl()
    await expect(network.request(guest.id)).resolves.toEqual({ cancel: true })
    await expect(network.request(guest.id, 'wss://example.test/socket', 'webSocket')).resolves.toEqual({ cancel: true })
    await expect(network.receiveHeaders(guest.id)).resolves.toEqual({ cancel: true })
    await expect(network.receiveHeaders(guest.id, true)).resolves.toEqual({ cancel: true })
    await expect(session.networkAuthorization.run(
      async () => {},
      undefined,
      () => network.request(guest.id),
      () => {},
    )).resolves.toEqual({ cancel: true })
    expect(network.permissionCheck?.()).toBe(false)
    const permission = new Promise<boolean>((resolve) => {
      network.permissionRequest!(guest, 'camera', resolve)
    })
    await expect(permission).resolves.toBe(false)
    let prevented = false
    network.emit('will-download', {
      preventDefault: () => { prevented = true },
    })
    expect(prevented).toBe(true)
    let trusted: boolean | undefined
    guest.emit('certificate-error', {}, guest.url, 'untrusted', {}, (value: boolean) => {
      trusted = value
    }, true)
    expect(trusted).toBe(false)
    prevented = false
    guest.emit('will-navigate', {
      preventDefault: () => { prevented = true },
    }, 'https://example.test/late')
    expect(prevented).toBe(true)
    await vi.advanceTimersByTimeAsync(5)
    await cleanupFailure
    expect(network.beforeRequest).toBe(beforeRequest)
    expect(network.headersReceived).toBe(headersReceived)
    expect(network.permissionCheck).toBe(permissionCheck)
    expect(network.permissionRequest).toBe(permissionRequest)
    expect(guest.listenerCount('certificate-error')).toBe(1)
    expect(guest.listenerCount('will-navigate')).toBe(1)
    expect(network.listenerCount('will-download')).toBe(1)
    guest.destroy()
    await session.whenIdle()
    await session.waitForCleanup()
    expect(network.beforeRequest).toBeNull()
    expect(network.headersReceived).toBeNull()
    expect(network.permissionCheck).toBeNull()
    expect(network.permissionRequest).toBeNull()
    expect(guest.listenerCount('certificate-error')).toBe(0)
    expect(guest.listenerCount('will-navigate')).toBe(0)
    expect(network.listenerCount('will-download')).toBe(0)
  })

  it('rejects request and download approvals that complete after quarantine starts', async () => {
    const { guest, session } = fixture()
    guest.autoDestroy = false
    const request = guest.session.request(guest.id)
    const download = guest.session.receiveHeaders(guest.id, true)
    session.releasePage()
    session.networkAuthorization.useHumanControl()
    await expect(request).resolves.toEqual({ cancel: true })
    await expect(download).resolves.toEqual({ cancel: true })
    guest.destroy()
    await session.whenIdle()
  })

  it('keeps another guest in the same partition usable while the quarantined guest is denied', async () => {
    const first = fixture()
    const guest = new Guest(first.guest.session)
    guest.id = 2
    const second = fixture(guest)
    first.guest.autoDestroy = false
    first.session.releasePage()
    first.session.networkAuthorization.useHumanControl()
    await expect(guest.session.request(first.guest.id)).resolves.toEqual({ cancel: true })
    await expect(guest.session.request(guest.id)).resolves.toEqual({ cancel: false })
    first.guest.destroy()
    await first.session.whenIdle()
    expect(guest.session.beforeRequest).not.toBeNull()
    await expect(guest.session.request(guest.id)).resolves.toEqual({ cancel: false })
    second.session.releasePage()
    await second.session.whenIdle()
    expect(guest.session.beforeRequest).toBeNull()
  })

  it('also cleans up timed-out CDP calls outside runWhileActive', async () => {
    const { guest, session } = fixture()
    guest.debugger.sendCommand.mockReturnValue(new Promise<never>(() => {}))
    const observation = session.semanticDriver!.waitForObservationReady()
    const failure = expect(observation).rejects.toMatchObject({ code: 'BROWSER_PAGE_UNRESPONSIVE' })
    await vi.advanceTimersByTimeAsync(30)
    await failure
    expect(guest.destroyed).toBe(true)
    expect(guest.debuggerAttached).toBe(false)
    expect(session.securityPolicy).toBeNull()
    expect(session.semanticDriver).toBeNull()
  })

  it('disposes observation caches before a late screenshot can repopulate them', async () => {
    const { guest, session } = fixture()
    guest.debugger.sendCommand.mockImplementation(async (method) => {
      if (method === 'Page.getFrameTree')
        return { frameTree: { frame: { id: 'main', url: guest.url } } }
      if (method === 'DOM.getDocument')
        return { root: { frameId: 'main' } }
      if (method === 'DOMSnapshot.captureSnapshot')
        return { documents: [{ frameId: 0, nodes: { backendNodeId: [], nodeName: [] }, layout: { bounds: [], nodeIndex: [] } }], strings: ['main'] }
      return {}
    })
    const driver = session.semanticDriver!
    const input = {
      mode: 'screenshot' as const,
      pageId: '3e45cd5b-c83b-411d-b0a7-7fe26ad8c6d0',
      sessionId: '97fe3047-adde-4c76-8b69-e714e658e052',
      status: 'ready' as const,
      title: 'Page',
      url: guest.url,
    }
    const initial = await driver.observe(input)
    expect(initial.screenshot).toBeDefined()
    driver.assertObservation(initial)
    const image = deferred<Awaited<ReturnType<Guest['capturePage']>>>()
    const capturing = deferred<void>()
    guest.capturePage.mockImplementation(() => {
      capturing.resolve()
      return image.promise
    })
    const observation = driver.observe(input)
    const failure = expect(observation).rejects.toThrow()
    await capturing.promise
    session.releasePage()
    await session.whenIdle()
    image.resolve({ getSize: () => ({ height: 1, width: 1 }), toPNG: () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) })
    await failure
    expect(session.semanticDriver).toBeNull()
    expect(() => driver.assertObservation(initial)).toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('release suppresses late results and state publications for a retired session', async () => {
    const { guest, session, states, retire } = fixture()
    const raw = deferred<string>()
    const operation = session.runWhileActive(() => raw.promise)
    const failure = expect(operation).rejects.toMatchObject({ code: 'BROWSER_PAGE_FAILED' })
    retire()
    const count = states.length
    session.releasePage()
    await session.whenIdle()
    await failure
    raw.resolve('late')
    guest.emit('page-title-updated', {}, 'Late')
    session.publish()
    await Promise.resolve()
    expect(states).toHaveLength(count)
    expect(session.page).toBeNull()
    expect(() => session.attach(new Guest().asPage())).toThrow()
  })

  it('rejects pending operations on an independently destroyed guest', async () => {
    const { guest, session } = fixture()
    const operation = session.runWhileActive(() => new Promise<never>(() => {}))
    const failure = expect(operation).rejects.toMatchObject({ code: 'BROWSER_PAGE_CRASHED' })
    guest.destroy()
    await failure
    expect(session.page).toBeNull()
    expect(session.state.error?.code).toBe('BROWSER_PAGE_CRASHED')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows untimed human selection but still bounds its nested CDP calls', async () => {
    const { guest, session } = fixture()
    const selection = deferred<void>()
    guest.debugger.sendCommand.mockReturnValue(new Promise<never>(() => {}))
    vi.spyOn(session.elementPicker!, 'start').mockImplementation(async () => {
      await selection.promise
      await session.semanticDriver!.waitForObservationReady()
      return { status: 'cancelled' }
    })
    const picked = session.pickElement('request')
    const failure = expect(picked).rejects.toMatchObject({ code: 'BROWSER_PAGE_UNRESPONSIVE' })
    await vi.advanceTimersByTimeAsync(60)
    expect(guest.destroyed).toBe(false)
    expect(guest.backgroundThrottling).toBe(false)
    selection.resolve()
    await vi.advanceTimersByTimeAsync(30)
    await failure
    expect(guest.destroyed).toBe(true)
    expect(guest.debuggerAttached).toBe(false)
  })

  it('keeps one overall deadline even when intermediate work keeps succeeding', async () => {
    const { guest, session } = fixture()
    const first = deferred<void>()
    const second = deferred<void>()
    const operation = session.runWhileActive(async () => {
      await first.promise
      await second.promise
    })
    const failure = expect(operation).rejects.toMatchObject({ code: 'BROWSER_PAGE_UNRESPONSIVE' })
    await vi.advanceTimersByTimeAsync(20)
    first.resolve()
    await vi.advanceTimersByTimeAsync(10)
    await failure
    expect(guest.destroyed).toBe(true)
    second.resolve()
    await Promise.resolve()
    expect(session.page).toBeNull()
  })
})
