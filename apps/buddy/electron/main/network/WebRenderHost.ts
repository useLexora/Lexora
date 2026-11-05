import type { NetworkAuthorizer } from '../../../shared/network/networkAuthorization'
import type { HostWebNetwork } from './HostWebNetwork'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { BrowserWindow, session } from 'electron'
import { readResponseBytes } from '../../../platform/network/publicWebTransport'
import { WebError } from '../../../shared/network/webProtocol'
import { requireWebSuccess } from '../../../shared/network/webTransport'

const SNAPSHOT_SCRIPT = `new Promise(resolve => {
  let timer;
  const finish = () => {
    clearTimeout(timer);
    clearTimeout(deadline);
    observer.disconnect();
    resolve(document.documentElement.outerHTML.slice(0, 4 * 1024 * 1024 + 1));
  };
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, 800); });
  const deadline = setTimeout(finish, 5000);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  timer = setTimeout(finish, 800);
})`

export async function renderWebDocument(network: HostWebNetwork, url: string, signal: AbortSignal, authorize: NetworkAuthorizer, track: (closed: Promise<void>) => void = () => {}, cleaning: () => void = () => {}): Promise<{ html: string, url: string }> {
  await network.authorizePublicUrl(url)
  signal.throwIfAborted()
  const lifetime = new AbortController()
  signal = AbortSignal.any([signal, lifetime.signal])
  const pending = new Set<Promise<Response>>()
  const closed: Promise<void>[] = []
  const trackRequest = (promise: Promise<void>) => {
    closed.push(promise)
    track(promise)
  }
  const isolated = session.fromPartition(`buddy-web-render:${randomUUID()}`, { cache: false })
  const cleaned = Promise.withResolvers<void>()
  track(cleaned.promise)
  let window: BrowserWindow | undefined
  let stopping: Promise<void> | undefined
  const stopLoading = () => stopping ??= setImmediate().then(() => {
    // loadURL can reject inside Chromium's navigation callback; Stop must leave that stack first.
    if (window && !window.isDestroyed())
      window.webContents.stop()
  })
  const abort = () => {
    void stopLoading().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    isolated.setPermissionCheckHandler(() => false)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setDevicePermissionHandler(() => false)
    isolated.on('will-download', event => event.preventDefault())
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
      },
    })
    const page = window.webContents
    page.setWindowOpenHandler(() => ({ action: 'deny' }))
    page.on('will-attach-webview', event => event.preventDefault())
    const mainRequests = new Set([url])
    let mainError: WebError | undefined
    let requests = 0
    let totalBytes = 0
    isolated.webRequest.onBeforeRequest((details, callback) => {
      if (details.resourceType === 'mainFrame')
        mainRequests.add(details.url)
      callback({ cancel: !(details.url === 'about:blank' || /^(?:https?:|data:|blob:)/.test(details.url)) || details.resourceType === 'webSocket' })
    })
    for (const scheme of ['http', 'https']) {
      isolated.protocol.handle(scheme, (request) => {
        const task = (async () => {
          try {
            if (request.method !== 'GET' || ++requests > 80)
              throw new WebError('WEB_URL_BLOCKED')
            const result = await network.fetch({ url: request.url, method: 'GET', headers: {}, scope: 'public' }, signal, { redirect: 'manual', authorize, track: trackRequest })
            if ([301, 302, 303, 307, 308].includes(result.response.status))
              return result.response
            if (mainRequests.has(request.url)) {
              requireWebSuccess(result.response.status)
            }
            const bytes = await readResponseBytes(result.response, 4 * 1024 * 1024)
            totalBytes += bytes.byteLength
            if (totalBytes > 16 * 1024 * 1024)
              throw new WebError('WEB_RESPONSE_TOO_LARGE')
            const headers = new Headers(result.response.headers)
            for (const key of ['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding'])
              headers.delete(key)
            return new Response([204, 205, 304].includes(result.response.status) ? null : Uint8Array.from(bytes), { status: result.response.status, headers })
          }
          catch (error) {
            if (mainRequests.has(request.url))
              mainError = error instanceof WebError ? error : new WebError('WEB_NETWORK_ERROR')
            return new Response('', { status: 502 })
          }
        })().finally(() => pending.delete(task))
        pending.add(task)
        return task
      })
    }
    await page.loadURL('about:blank')
    page.debugger.attach('1.3')
    await page.debugger.sendCommand('Page.enable')
    await page.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true, cancel: true })
    signal.throwIfAborted()
    await page.loadURL(url)
    if (mainError)
      throw mainError
    const html: unknown = await page.executeJavaScript(SNAPSHOT_SCRIPT)
    signal.throwIfAborted()
    if (mainError)
      throw mainError
    if (typeof html !== 'string')
      throw new WebError('WEB_INVALID_RESPONSE')
    if (html.length > 4 * 1024 * 1024)
      throw new WebError('WEB_RESPONSE_TOO_LARGE')
    const finalUrl = (await network.authorizePublicUrl(page.getURL())).href
    await authorize(finalUrl, 'access', signal)
    signal.throwIfAborted()
    return { html, url: finalUrl }
  }
  finally {
    cleaning()
    const cleanup = (async () => {
      signal.removeEventListener('abort', abort)
      await stopLoading()
      lifetime.abort(new WebError('WEB_CANCELLED'))
      for (const scheme of ['http', 'https'])
        isolated.protocol.unhandle(scheme)
      isolated.webRequest.onBeforeRequest(null)
      await Promise.allSettled([...pending])
      await Promise.all(closed)
      if (window && !window.isDestroyed())
        window.destroy()
      await Promise.all([isolated.clearStorageData(), isolated.clearCache(), isolated.closeAllConnections()])
    })()
    void cleanup.then(cleaned.resolve, cleaned.reject)
    await cleanup
  }
}
