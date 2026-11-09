import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { ExtensionPackage } from '../../../platform/extensions/ExtensionPackageStore'
import type { ExtensionHost } from '../../../platform/extensions/ExtensionService'
import type { ExtensionHostFailure } from '../../../shared/extensions/extensionDiagnostic'
import type { JsonValue } from '../../../shared/workbench/workbenchState'
import type { ExtensionProtocol } from './ExtensionProtocol'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BrowserWindow, session } from 'electron'
import { z } from 'zod'
import { EXTENSION_IPC, extensionError, extensionJsonSchema } from '../../../shared/extensions/extensionApi'
import { ExtensionRequestError } from '../../../shared/extensions/extensionDiagnostic'

interface Pending { method: string, resolve: (value: JsonValue) => void, reject: (error: Error) => void, cleanup: () => void }
const heartbeatInterval = 5000
const heartbeatTimeout = 15000
const replySchema = z.object({ id: z.string().uuid(), ok: z.boolean(), value: extensionJsonSchema }).strict()
const replyIdentitySchema = z.object({ id: z.string().uuid() })

export class SandboxedExtensionHost implements ExtensionHost {
  readonly window: BrowserWindow
  readonly #pending = new Map<string, Pending>()
  readonly #ready: Promise<void>
  readonly #broker: (method: string, params: unknown) => Promise<JsonValue>
  readonly #cleanup: () => Promise<void>
  readonly #onFailure: (failure: ExtensionHostFailure) => void
  #resolveReady!: () => void
  #rejectReady!: (error: Error) => void
  #heartbeatTimer?: ReturnType<typeof setInterval>
  #probe?: { id: string, time: number }
  #failed = false
  #closing = false
  #disposal: Promise<void> | undefined
  #started = false
  #developerWindow: BrowserWindow | null = null
  #readyTimer: ReturnType<typeof setTimeout>

  constructor(pkg: ExtensionPackage, protocol: ExtensionProtocol, broker: (method: string, params: unknown) => Promise<JsonValue>, failed: (failure: ExtensionHostFailure) => void) {
    this.#broker = broker
    this.#onFailure = failed
    const endpoint = protocol.register(pkg, 'host')
    const isolated = session.fromPartition(`lexora-extension:${randomUUID()}`, { cache: false })
    const stopProtocol = protocol.install(isolated, 'host', endpoint.token)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const devtools = this.#developerWindow?.webContents
      const developerResource = devtools && details.webContentsId === devtools.id && details.url.startsWith('devtools://devtools/')
      callback({ cancel: !developerResource && !details.url.startsWith(`lexora-extension://${endpoint.token}/`) })
    })
    this.window = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { preload: join(import.meta.dirname, '../preload/extensionHost.cjs'), session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true, webviewTag: false, spellcheck: false, backgroundThrottling: false } })
    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve
      this.#rejectReady = reject
    })
    void this.#ready.catch(() => {})
    this.#readyTimer = setTimeout(() => this.#fail({ code: 'EXTENSION_REQUEST_TIMEOUT', method: 'ready', stage: 'timeout' }), 15000)
    const cleanup = [
      () => endpoint.dispose(),
      stopProtocol,
      () => isolated.closeAllConnections(),
      () => {
        if (!this.window.isDestroyed())
          this.window.destroy()
        if (!this.window.isDestroyed())
          throw new Error('EXTENSION_HOST_STOP_FAILED')
      },
      () => isolated.webRequest.onBeforeRequest(null),
    ]
    this.#cleanup = async () => {
      while (cleanup.length) {
        await cleanup[0]!()
        cleanup.shift()
      }
    }
    const contents = this.window.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('will-frame-navigate', event => event.preventDefault())
    contents.on('render-process-gone', () => this.#fail())
    contents.on('unresponsive', () => this.#fail({ code: 'EXTENSION_HOST_UNRESPONSIVE', method: 'unknown', stage: 'process' }))
    contents.on('devtools-closed', () => this.#closeDeveloperWindow())
    this.window.on('closed', () => this.#fail())
    void this.window.loadURL(endpoint.url).catch(() => this.#fail({ code: 'EXTENSION_HOST_LOAD_FAILED', method: 'unknown', stage: 'process' }))
  }

  owns(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
    return !this.window.isDestroyed() && event.sender === this.window.webContents && event.senderFrame === this.window.webContents.mainFrame
  }

  async request(method: unknown, params: unknown): Promise<JsonValue> {
    try {
      if (this.#closing || this.#failed)
        throw new Error('EXTENSION_HOST_STOPPED')
      if (method === 'ready') {
        if (this.#started)
          throw new Error('EXTENSION_METHOD_DENIED')
        this.#started = true
        clearTimeout(this.#readyTimer)
        this.#resolveReady()
        return null
      }
      if (!this.#started || typeof method !== 'string' || method.length > 80)
        throw new Error('EXTENSION_METHOD_DENIED')
      return await this.#broker(method, params)
    }
    catch (error) {
      throw new Error(extensionError(error))
    }
  }

  reply(raw: unknown): void {
    const parsed = replySchema.safeParse(raw)
    if (!parsed.success) {
      const identity = replyIdentitySchema.safeParse(raw)
      const pending = identity.success ? this.#pending.get(identity.data.id) : undefined
      if (pending && identity.success) {
        this.#pending.delete(identity.data.id)
        pending.cleanup()
        pending.reject(new ExtensionRequestError('EXTENSION_INVALID_RESULT', pending.method, parsed.error, 'result'))
      }
      return
    }
    const { id, ok, value } = parsed.data
    if (id === this.#probe?.id) {
      if (ok && value === null)
        this.#probe = undefined
      return
    }
    const pending = this.#pending.get(id)
    if (!pending)
      return
    this.#pending.delete(id)
    pending.cleanup()
    if (ok)
      pending.resolve(value)
    else pending.reject(new Error(typeof value === 'string' && /^EXTENSION_[A-Z_]+$/.test(value) ? value : 'EXTENSION_OPERATION_FAILED'))
  }

  async call(method: string, params: JsonValue, signal?: AbortSignal): Promise<JsonValue> {
    await this.#ready
    if (this.#closing || this.#failed || this.window.isDestroyed())
      throw new Error('EXTENSION_HOST_STOPPED')
    if (this.#pending.size >= 64)
      throw new Error('EXTENSION_REQUEST_LIMIT')
    // A pending async operation is not evidence of a hung renderer. Callers own
    // operation cancellation; the independent probe checks the host event loop.
    return this.#send(method, params, 0, signal)
  }

  devtools(): void {
    if (this.#closing || this.window.isDestroyed())
      return
    if (this.#developerWindow) {
      this.#developerWindow.show()
      this.#developerWindow.focus()
      return
    }
    const developerWindow = new BrowserWindow({ width: 1000, height: 700, webPreferences: { session: this.window.webContents.session, sandbox: true, nodeIntegration: false, contextIsolation: true, webviewTag: false, devTools: false } })
    this.#developerWindow = developerWindow
    developerWindow.once('closed', () => {
      if (this.#developerWindow === developerWindow)
        this.#developerWindow = null
    })
    developerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    developerWindow.webContents.on('will-frame-navigate', event => event.preventDefault())
    this.window.webContents.setDevToolsWebContents(developerWindow.webContents)
    this.window.webContents.openDevTools({ mode: 'detach' })
  }

  dispose(): Promise<void> {
    if (this.#disposal)
      return this.#disposal
    this.#closing = true
    this.#rejectAll()
    this.#disposal = Promise.resolve().then(async () => {
      if (this.#started && !this.window.isDestroyed())
        await this.#send('deactivate', null, 1500).catch(() => {})
      this.#rejectAll()
      this.#closeDeveloperWindow()
      await this.#cleanup()
    }).catch((error) => {
      this.#disposal = undefined
      throw error
    })
    return this.#disposal
  }

  #send(method: string, params: JsonValue, timeout: number, signal?: AbortSignal): Promise<JsonValue> {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const pending = this.#pending
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        if (!pending.size)
          this.#clearHeartbeat()
      }
      function cancel() {
        pending.delete(id)
        cleanup()
        reject(new Error('EXTENSION_AGENT_CANCELLED'))
      }
      const expire = () => {
        pending.delete(id)
        cleanup()
        reject(new Error('EXTENSION_REQUEST_TIMEOUT'))
      }
      // Only forced deactivation has a transport-owned completion deadline.
      timer = timeout ? setTimeout(expire, timeout) : undefined
      pending.set(id, { method, resolve, reject, cleanup })
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        this.window.webContents.send(EXTENSION_IPC.hostMessage, { id, method, params })
        this.#watchResponsiveness()
      }
      catch (error) {
        pending.delete(id)
        cleanup()
        reject(error)
        this.#fail()
      }
    })
  }

  #watchResponsiveness(): void {
    if (this.#closing || this.#failed || !this.#pending.size || this.#heartbeatTimer || this.#probe)
      return
    let lastCheck = Date.now()
    let nextProbe = lastCheck + heartbeatInterval
    this.#heartbeatTimer = setInterval(() => {
      const now = Date.now()
      // Like the view watchdog, require continuous observations. A suspended
      // machine/main event loop (or clock adjustment) invalidates an old probe.
      if (now < lastCheck || now - lastCheck > 3000) {
        this.#probe = undefined
        nextProbe = now
      }
      lastCheck = now
      if (this.#probe) {
        if (now - this.#probe.time >= heartbeatTimeout)
          this.#fail({ code: 'EXTENSION_HOST_UNRESPONSIVE', method: 'ping', stage: 'timeout' })
        return
      }
      if (now < nextProbe)
        return
      const id = randomUUID()
      this.#probe = { id, time: now }
      nextProbe = now + heartbeatInterval
      try {
        this.window.webContents.send(EXTENSION_IPC.hostMessage, { id, method: 'ping', params: null })
      }
      catch {
        this.#fail()
      }
    }, 1000)
  }

  #clearHeartbeat(): void {
    clearInterval(this.#heartbeatTimer)
    this.#heartbeatTimer = undefined
    this.#probe = undefined
  }

  #closeDeveloperWindow(): void {
    const window = this.#developerWindow
    this.#developerWindow = null
    try {
      if (window && !window.isDestroyed())
        window.destroy()
      if (window && !window.isDestroyed())
        throw new Error('EXTENSION_HOST_STOP_FAILED')
    }
    catch (error) {
      this.#developerWindow = window
      throw error
    }
  }

  #fail(failure: ExtensionHostFailure = { code: 'EXTENSION_HOST_CRASHED', method: 'unknown', stage: 'process' }): void {
    if (this.#closing || this.#failed)
      return
    this.#failed = true
    this.#rejectAll(failure.code)
    this.#onFailure(failure)
  }

  #rejectAll(reason = 'EXTENSION_HOST_STOPPED'): void {
    clearTimeout(this.#readyTimer)
    this.#clearHeartbeat()
    this.#rejectReady(new Error(reason))
    for (const pending of this.#pending.values()) {
      pending.cleanup()
      pending.reject(new Error(reason))
    }
    this.#pending.clear()
  }
}
