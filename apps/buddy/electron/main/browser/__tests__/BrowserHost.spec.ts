import { pathToFileURL } from 'node:url'
import { deferred as createDeferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { BrowserHostError } from '../BrowserHost'
import { configureSemanticObservation, createFixture, createLocalSite } from './browserHostFixture'

describe('browserHost sessions and navigation', () => {
  it('reads the current default zoom only for new pages and explicit reset', async () => {
    let defaultZoomFactor = 1.25
    const fixture = createFixture({ getDefaultZoomFactor: () => defaultZoomFactor })
    const first = fixture.host.ensureSession(null, 'first')
    expect(first.zoomFactor).toBe(1.25)
    defaultZoomFactor = 1.5
    const second = fixture.host.ensureSession(null, 'second')
    expect(second.zoomFactor).toBe(1.5)
    expect(fixture.host.getState(first.sessionId).zoomFactor).toBe(1.25)
    expect((await fixture.host.setZoomFactor(first.sessionId, 2)).zoomFactor).toBe(2)
    expect(fixture.host.getState(second.sessionId).zoomFactor).toBe(1.5)
    expect((await fixture.host.setZoomFactor(first.sessionId, null)).zoomFactor).toBe(1.5)
    await expect(fixture.host.setZoomFactor(first.sessionId, 10)).rejects.toThrow()
    expect(fixture.host.getState(first.sessionId).zoomFactor).toBe(1.5)
    fixture.host.dispose()
  })

  it('releases a shared debugger connection and page listeners when the page closes', async () => {
    const fixture = createFixture()
    const state = fixture.host.ensureSession('conversation')
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(state.sessionId, 'https://example.com/')
    await fixture.host.observe({ sessionId: state.sessionId, pageId: state.pageId })
    expect(fixture.webContents.debuggerAttached).toBe(true)
    fixture.host.close(state.sessionId)
    expect(fixture.webContents.debuggerAttached).toBe(false)
    expect(fixture.webContents.eventNames()).toEqual([])
    expect(fixture.webContents.session.eventNames()).toEqual([])
    fixture.onStateChanged.mockClear()
    fixture.webContents.emit('did-navigate', {}, 'https://obsolete.example/')
    expect(fixture.onStateChanged).not.toHaveBeenCalled()
    fixture.host.dispose()
  })

  it('keeps standalone tabs independent through conversation and profile changes', async () => {
    const fixture = createFixture()
    const first = fixture.host.ensureSession(null, 'manual-1')
    const second = fixture.host.ensureSession(null, 'manual-2')
    const agent = fixture.host.ensureSession('conversation')
    expect(new Set([first.sessionId, second.sessionId, agent.sessionId]).size).toBe(3)
    expect(first.conversationId).toBeNull()
    expect(fixture.host.ensureSession(null, 'manual-1').sessionId).toBe(first.sessionId)
    expect(fixture.host.getStateForConversation('conversation').sessionId).toBe(agent.sessionId)
    expect(() => fixture.host.acquireControl({ sessionId: first.sessionId, pageId: first.pageId }))
      .toThrowError(expect.objectContaining({ code: 'BROWSER_CONTROL_REQUIRED' }))

    const incognito = await fixture.host.setProfileMode(first.sessionId, 'incognito')
    expect(incognito).toMatchObject({ conversationId: null, profileMode: 'incognito', controller: 'human' })
    expect(incognito.sessionId).not.toBe(first.sessionId)
    expect(fixture.host.ensureSession(null, 'manual-1').sessionId).toBe(incognito.sessionId)
    fixture.host.close(incognito.sessionId)
    expect(fixture.host.getState(second.sessionId).sessionId).toBe(second.sessionId)
    expect(fixture.host.getStateForConversation('conversation').sessionId).toBe(agent.sessionId)
  })

  it('describes one isolated renderer-owned guest per conversation', () => {
    const fixture = createFixture()

    const first = fixture.host.ensureSession('conversation-1')
    const second = fixture.host.ensureSession('conversation-1')

    expect(second).toEqual(first)
    expect(fixture.createPage).toHaveBeenCalledOnce()
    expect(fixture.guestDescriptors).toEqual([{
      partition: 'persist:buddy-browser-default-v1',
      sessionId: first.sessionId,
    }])
    expect(fixture.host.listGuests()).toEqual(fixture.guestDescriptors)

    const event = { preventDefault: vi.fn() }
    const webPreferences: Record<string, unknown> = {
      nodeIntegration: true,
      preload: '/untrusted/preload.cjs',
      sandbox: false,
    }
    fixture.window.webContents.emit('will-attach-webview', event, webPreferences, {
      partition: 'persist:buddy-browser-default-v1',
      src: 'about:blank',
    })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(webPreferences).toMatchObject({
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: false,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    })
    expect(webPreferences).not.toHaveProperty('preload')
    expect(fixture.webContents.session.setPermissionCheckHandler).toHaveBeenCalledOnce()
    expect(fixture.webContents.session.setPermissionRequestHandler).toHaveBeenCalledOnce()
    expect(first.profileMode).toBe('default')
    expect(first.security).toEqual({ kind: 'blank', origin: null })
  })

  it('switches one browser tab profile without replacing the agent or other tabs', async () => {
    const fixture = createFixture()
    const agent = fixture.host.ensureSession('conversation')
    const first = fixture.host.ensureSession('conversation', 'first')
    const second = fixture.host.ensureSession('conversation', 'second')
    const privateTab = await fixture.host.setProfileMode(first.sessionId, 'incognito')
    expect(fixture.host.ensureSession('conversation')).toEqual(agent)
    expect(fixture.host.ensureSession('conversation', 'second')).toEqual(second)
    expect(fixture.host.ensureSession('conversation', 'first')).toEqual(privateTab)
    expect(privateTab.profileMode).toBe('incognito')
    expect(() => fixture.host.getState(first.sessionId)).toThrow()
  })

  it('switches between default and incognito without clearing saved browser data', async () => {
    const fixture = createFixture()
    const initial = fixture.host.ensureSession('conversation-1')
    fixture.host.setSurface({ sessionId: initial.sessionId, visible: true })
    await fixture.host.navigate(initial.sessionId, 'http://127.0.0.1:4173/account')

    const incognito = await fixture.host.setProfileMode(initial.sessionId, 'incognito')

    expect(incognito).toMatchObject({
      conversationId: 'conversation-1',
      profileMode: 'incognito',
      url: 'http://127.0.0.1:4173/account',
      visible: true,
    })
    expect(incognito.sessionId).not.toBe(initial.sessionId)
    expect(incognito.pageId).not.toBe(initial.pageId)
    expect(fixture.guestDescriptors.at(1)?.partition).toBe(
      `buddy-browser-incognito:${incognito.sessionId}`,
    )
    expect(fixture.webContentsInstances.at(0)?.close).toHaveBeenCalledOnce()
    expect(fixture.webContentsInstances.at(1)?.loadURL).toHaveBeenCalledExactlyOnceWith(
      'http://127.0.0.1:4173/account',
    )
    expect(() => fixture.host.getState(initial.sessionId)).toThrowError(BrowserHostError)

    const restoredDefault = await fixture.host.setProfileMode(incognito.sessionId, 'default')

    expect(restoredDefault).toMatchObject({
      conversationId: 'conversation-1',
      profileMode: 'default',
      url: 'http://127.0.0.1:4173/account',
    })
    expect(fixture.guestDescriptors.at(2)?.partition).toBe(
      'persist:buddy-browser-default-v1',
    )
    expect(fixture.webContentsInstances.every(contents => (
      contents.session.clearStorageData.mock.calls.length === 0
      && contents.session.clearCache.mock.calls.length === 0
      && contents.session.flushStorageData.mock.calls.length === 0
    ))).toBe(true)
  })

  it('does not carry a local file grant across profile switches', async () => {
    const fixture = createFixture()
    const initial = fixture.host.ensureSession('conversation-1')
    const local = await createLocalSite()
    await fixture.host.openLocalFile(initial.sessionId, {
      entryPath: local.entryPath,
      rootPath: local.rootPath,
    })

    const incognito = await fixture.host.setProfileMode(initial.sessionId, 'incognito')

    expect(incognito).toMatchObject({
      profileMode: 'incognito',
      url: 'about:blank',
    })
    expect(fixture.webContentsInstances.at(1)?.loadURL).not.toHaveBeenCalled()
  })

  it('switches isolated conversation pages without losing their state', async () => {
    const fixture = createFixture()
    const first = fixture.host.ensureSession('conversation-1')
    const second = fixture.host.ensureSession('conversation-2')

    await fixture.host.navigate(first.sessionId, 'https://example.com/first')
    await fixture.host.navigate(second.sessionId, 'https://example.com/second')

    expect(fixture.guestDescriptors.map(descriptor => descriptor.partition)).toEqual([
      'persist:buddy-browser-default-v1',
      'persist:buddy-browser-default-v1',
    ])

    fixture.host.setSurface({ sessionId: first.sessionId, visible: true })
    fixture.host.setSurface({ sessionId: second.sessionId, visible: true })

    expect(fixture.host.getState(first.sessionId)).toMatchObject({
      url: 'https://example.com/first',
      visible: false,
    })
    expect(fixture.host.getState(second.sessionId)).toMatchObject({
      url: 'https://example.com/second',
      visible: true,
    })

    fixture.host.setSurface({ sessionId: first.sessionId, visible: true })

    expect(fixture.host.getState(first.sessionId)).toMatchObject({
      url: 'https://example.com/first',
      visible: true,
    })
    expect(fixture.host.getState(second.sessionId)).toMatchObject({
      url: 'https://example.com/second',
      visible: false,
    })
    expect(fixture.webContentsInstances.every(contents => (
      contents.close.mock.calls.length === 0
    ))).toBe(true)
  })

  it('navigates the owned page and rejects non-web schemes in Main', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')

    await expect(fixture.host.navigate(
      session.sessionId,
      'https://10.0.0.5/',
    )).resolves.toMatchObject({
      security: { kind: 'secure', origin: 'https://10.0.0.5' },
      status: 'ready',
      url: 'https://10.0.0.5/',
    })
    expect(fixture.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(
      'https://10.0.0.5/',
    )

    await expect(fixture.host.navigate(
      session.sessionId,
      'javascript:alert(1)',
    )).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_BLOCKED' })
  })

  it('recovers semantic observation from a stale page load error when the page is still live', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(session.sessionId, 'https://example.com/app')
    fixture.webContents.emit(
      'did-fail-load',
      {},
      -2,
      'ERR_FAILED',
      'https://example.com/app',
      true,
    )

    await expect(fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).resolves.toMatchObject({
      status: 'ready',
      url: 'https://example.com/app',
    })
    expect(fixture.host.getState(session.sessionId)).toMatchObject({
      error: null,
      status: 'ready',
      url: 'https://example.com/app',
    })
  })

  it('rejects semantic observation with the active crash or unresponsive error', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    await fixture.host.navigate(session.sessionId, 'https://example.com/app')
    fixture.webContents.debugger.sendCommand.mockClear()

    fixture.webContents.emit('unresponsive')
    expect(fixture.host.getState(session.sessionId)).toMatchObject({
      error: { code: 'BROWSER_PAGE_UNRESPONSIVE' },
      status: 'error',
    })

    await expect(fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).rejects.toMatchObject({ code: 'BROWSER_PAGE_UNRESPONSIVE' })
    expect(fixture.webContents.debugger.sendCommand).not.toHaveBeenCalled()

    fixture.webContents.emit('responsive')
    expect(fixture.host.getState(session.sessionId)).toMatchObject({ error: null, status: 'ready' })
    fixture.webContents.emit('render-process-gone')
    expect(fixture.host.getState(session.sessionId)).toMatchObject({
      error: { code: 'BROWSER_PAGE_CRASHED' },
      status: 'error',
    })

    await expect(fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).rejects.toMatchObject({ code: 'BROWSER_PAGE_CRASHED' })
    expect(fixture.webContents.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('reloads a page and stops an active load without reporting an abort failure', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    const deferred = createDeferred<void>()
    const targetUrl = 'http://127.0.0.1:4173/slow'
    fixture.webContents.loadURL.mockImplementationOnce((url) => {
      fixture.webContents.currentUrl = url
      return deferred.promise
    })

    const navigation = fixture.host.navigate(session.sessionId, targetUrl)
    await vi.waitFor(() => expect(fixture.webContents.loadURL).toHaveBeenCalledOnce())

    fixture.host.stop(session.sessionId)
    fixture.webContents.emit(
      'did-fail-load',
      {},
      -3,
      'ERR_ABORTED',
      targetUrl,
      true,
    )
    deferred.reject(new Error('ERR_ABORTED'))

    await expect(navigation).resolves.toMatchObject({
      error: null,
      status: 'ready',
      url: targetUrl,
    })
    expect(fixture.webContents.stop).toHaveBeenCalledOnce()

    fixture.host.reload(session.sessionId)

    expect(fixture.webContents.reload).toHaveBeenCalledOnce()
    expect(fixture.host.getState(session.sessionId).status).toBe('loading')
  })

  it('accepts a client redirect that aborts the initial load before the final page is ready', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    const deferred = createDeferred<void>()
    const initialUrl = 'https://example.com/'
    const redirectedUrl = 'https://example.com/city/'
    fixture.webContents.loadURL.mockImplementationOnce((url) => {
      fixture.webContents.currentUrl = url
      return deferred.promise
    })

    const navigation = fixture.host.navigate(session.sessionId, initialUrl)
    await vi.waitFor(() => expect(fixture.webContents.loadURL).toHaveBeenCalledOnce())

    fixture.webContents.emit(
      'did-fail-load',
      {},
      -3,
      'ERR_ABORTED',
      initialUrl,
      true,
    )
    deferred.reject(new Error(`ERR_ABORTED (-3) loading '${initialUrl}'`))
    await Promise.resolve()
    fixture.webContents.currentUrl = redirectedUrl
    fixture.webContents.emit('did-navigate', {}, redirectedUrl)
    fixture.webContents.emit('did-stop-loading')

    await expect(navigation).resolves.toMatchObject({
      error: null,
      status: 'ready',
      url: redirectedUrl,
    })
  })

  it('keeps a replacement load in the original navigation after the initial load rejects', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    const deferred = createDeferred<void>()
    const initialUrl = 'https://example.com/'
    const redirectedUrl = 'https://example.com/city/'
    fixture.webContents.loadURL.mockImplementationOnce((url) => {
      fixture.webContents.currentUrl = url
      fixture.webContents.emit('did-start-loading')
      return deferred.promise
    })

    const navigation = fixture.host.navigate(session.sessionId, initialUrl)
    await vi.waitFor(() => expect(fixture.webContents.loadURL).toHaveBeenCalledOnce())

    fixture.webContents.emit(
      'did-fail-load',
      {},
      -2,
      'ERR_FAILED',
      initialUrl,
      true,
    )
    deferred.reject(new Error(`ERR_FAILED (-2) loading '${initialUrl}'`))
    await Promise.resolve()
    fixture.webContents.emit('did-start-loading')
    await new Promise(resolve => setTimeout(resolve, 75))
    fixture.webContents.currentUrl = redirectedUrl
    fixture.webContents.emit('did-navigate', {}, redirectedUrl)
    fixture.webContents.emit('did-stop-loading')

    await expect(navigation).resolves.toMatchObject({
      error: null,
      status: 'ready',
      url: redirectedUrl,
    })
  })

  it('returns Chromium network failures without retrying the navigation', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    const url = 'https://example.com/'
    fixture.webContents.loadURL.mockImplementationOnce(async (target) => {
      fixture.webContents.currentUrl = target
      fixture.webContents.emit('did-start-loading')
      fixture.webContents.emit('did-fail-load', {}, -7, 'ERR_TIMED_OUT', target, true)
      fixture.webContents.emit('did-start-loading')
      fixture.webContents.emit('did-stop-loading')
      throw new Error(`ERR_TIMED_OUT (-7) loading '${target}'`)
    })

    await expect(fixture.host.navigate(session.sessionId, url)).rejects.toMatchObject({
      code: 'BROWSER_PAGE_FAILED',
      message: 'ERR_TIMED_OUT',
    })
    expect(fixture.webContents.loadURL).toHaveBeenCalledOnce()
    expect(fixture.host.getState(session.sessionId)).toMatchObject({ status: 'error' })
  })

  it('returns the Chromium load rejection when no failure event follows', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    const url = 'http://127.0.0.1:65534/'
    fixture.webContents.loadURL.mockRejectedValueOnce(
      new Error(`ERR_CONNECTION_REFUSED (-102) loading '${url}'`),
    )

    await expect(fixture.host.navigate(session.sessionId, url)).rejects.toMatchObject({
      code: 'BROWSER_PAGE_FAILED',
      message: `ERR_CONNECTION_REFUSED (-102) loading '${url}'`,
    })
    expect(fixture.webContents.loadURL).toHaveBeenCalledOnce()
    expect(fixture.host.getState(session.sessionId)).toMatchObject({ status: 'error' })
  })

  it('preserves the Chromium failure when the clock crosses the settlement deadline during a poll', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    const message = 'ERR_CONNECTION_REFUSED (-102)'
    fixture.webContents.loadURL.mockImplementationOnce(async () => {
      let now = 0
      vi.spyOn(Date, 'now').mockImplementation(() => now += 100)
      throw new Error(message)
    })

    const failure = expect(fixture.host.navigate(session.sessionId, 'http://127.0.0.1:65534/'))
      .rejects
      .toMatchObject({ code: 'BROWSER_PAGE_FAILED', message })
    await Promise.all([failure, vi.advanceTimersByTimeAsync(1_000)])
    expect(fixture.host.getState(session.sessionId)).toMatchObject({
      status: 'error',
      error: { code: 'BROWSER_PAGE_FAILED', message },
    })
  })

  it('does not start a navigation after it is stopped during authorization', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    const fileChooserGuard = createDeferred<unknown>()
    fixture.webContents.debugger.sendCommand.mockImplementationOnce(() => fileChooserGuard.promise)

    const navigation = fixture.host.navigate(session.sessionId, 'https://example.com/docs')
    await vi.waitFor(() => {
      expect(fixture.host.getState(session.sessionId).status).toBe('loading')
    })
    fixture.host.stop(session.sessionId)
    fileChooserGuard.resolve({})

    await expect(navigation).resolves.toMatchObject({
      status: 'idle',
      url: 'about:blank',
    })
    expect(fixture.webContents.loadURL).not.toHaveBeenCalled()
  })

  it('navigates a Runtime-authorized local file directly', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    const local = await createLocalSite()
    const entryUrl = pathToFileURL(local.entryPath).toString()

    await expect(fixture.host.openLocalFile(session.sessionId, {
      entryPath: local.entryPath,
      rootPath: local.rootPath,
    })).resolves.toMatchObject({
      security: { kind: 'local', origin: 'file://' },
      sessionId: session.sessionId,
      status: 'ready',
      url: entryUrl,
    })

    expect(fixture.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(entryUrl)
  })

  it('ignores an obsolete main-frame failure reported after a later commit', () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    const initialUrl = 'https://example.com/'
    const committedUrl = 'https://example.com/city/'

    fixture.webContents.currentUrl = committedUrl
    fixture.webContents.emit('did-navigate', {}, committedUrl)
    fixture.webContents.emit('did-stop-loading')
    fixture.webContents.emit(
      'did-fail-load',
      {},
      -105,
      'NAME_NOT_RESOLVED',
      initialUrl,
      true,
    )

    expect(fixture.host.getState(session.sessionId)).toMatchObject({
      error: null,
      status: 'ready',
      url: committedUrl,
    })
  })

  it('does not expose Chromium internal error-page URLs as browser state', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    const targetUrl = 'https://example.com/unavailable'
    await fixture.host.navigate(session.sessionId, targetUrl)

    fixture.webContents.currentUrl = 'chrome-error://chromewebdata/'
    fixture.webContents.emit('did-stop-loading')

    expect(fixture.host.getState(session.sessionId)).toMatchObject({
      security: {
        kind: 'secure',
        origin: 'https://example.com',
      },
      url: targetUrl,
    })
  })

  it('rejects certificate errors and projects the failing page', () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    const callback = vi.fn()

    fixture.webContents.emit(
      'certificate-error',
      {},
      'https://expired.example/',
      'net::ERR_CERT_DATE_INVALID',
      {},
      callback,
      true,
    )

    expect(callback).toHaveBeenCalledExactlyOnceWith(false)
    fixture.webContents.currentUrl = 'chrome-error://chromewebdata/'
    fixture.webContents.emit('did-fail-load', {}, -201, 'ERR_CERT_DATE_INVALID', 'https://expired.example/', true)
    fixture.webContents.emit('did-stop-loading')
    expect(fixture.host.getState(session.sessionId)).toMatchObject({
      error: {
        code: 'BROWSER_CERTIFICATE_ERROR',
        message: 'net::ERR_CERT_DATE_INVALID',
      },
      security: {
        kind: 'certificate-error',
        origin: 'https://expired.example',
      },
      status: 'error',
      url: 'https://expired.example/',
    })
  })

  it('projects an explicit permission-denied state without treating the page as crashed', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    await fixture.host.navigate(session.sessionId, 'https://example.com/')
    const callback = vi.fn()

    fixture.webContents.session.permissionRequestHandler?.(
      fixture.webContents,
      'geolocation',
      callback,
    )

    expect(callback).toHaveBeenCalledExactlyOnceWith(false)
    expect(fixture.host.getState(session.sessionId)).toMatchObject({
      error: { code: 'BROWSER_PERMISSION_DENIED' },
      status: 'ready',
    })
    expect(fixture.onStateChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'BROWSER_PERMISSION_DENIED' }),
    }))
  })

  it('closes views and listeners on session close and window teardown', () => {
    const fixture = createFixture()
    const first = fixture.host.ensureSession('conversation-1')
    fixture.host.setSurface({
      sessionId: first.sessionId,
      visible: true,
    })

    fixture.host.close(first.sessionId)

    expect(fixture.webContents.close).toHaveBeenCalledOnce()
    expect(fixture.onSessionClosed).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: first.sessionId }),
      'closed',
    )
    expect(() => fixture.host.getState(first.sessionId)).toThrowError(BrowserHostError)

    const second = fixture.host.ensureSession('conversation-2')
    fixture.window.emit('closed')

    expect(fixture.host.isDisposed).toBe(true)
    expect(() => fixture.host.getState(second.sessionId)).toThrowError(BrowserHostError)
    expect(fixture.webContentsInstances.at(-1)?.close).toHaveBeenCalledOnce()
    expect(fixture.onSessionClosed).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: second.sessionId }),
      'disposed',
    )
    expect(fixture.window.listenerCount('hide')).toBe(0)
    expect(fixture.window.listenerCount('minimize')).toBe(0)
    expect(fixture.window.listenerCount('restore')).toBe(0)
    expect(fixture.window.listenerCount('show')).toBe(0)
    expect(fixture.window.webContents.listenerCount('will-attach-webview')).toBe(0)
  })

  it('protects the visible session and evicts the least recently used detached page', () => {
    const fixture = createFixture()
    const first = fixture.host.ensureSession('conversation-1')
    fixture.host.setSurface({
      sessionId: first.sessionId,
      visible: true,
    })
    const second = fixture.host.ensureSession('conversation-2')
    fixture.host.ensureSession('conversation-3')
    fixture.host.ensureSession('conversation-4')

    fixture.host.ensureSession('conversation-5')

    expect(fixture.host.getState(first.sessionId)).toMatchObject({
      conversationId: 'conversation-1',
      visible: true,
    })
    expect(() => fixture.host.getState(second.sessionId)).toThrowError(BrowserHostError)
    expect(fixture.webContentsInstances.at(0)?.close).not.toHaveBeenCalled()
    expect(fixture.webContentsInstances.at(1)?.close).toHaveBeenCalledOnce()
    expect(fixture.onStateChanged).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-2',
      error: expect.objectContaining({ code: 'BROWSER_SESSION_EVICTED' }),
      status: 'error',
    }))

    expect(fixture.host.ensureSession('conversation-2')).toMatchObject({
      conversationId: 'conversation-2',
      error: { code: 'BROWSER_SESSION_EVICTED' },
      status: 'error',
      url: 'about:blank',
    })
  })
})
