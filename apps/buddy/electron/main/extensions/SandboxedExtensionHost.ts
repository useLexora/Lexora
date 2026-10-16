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

interface Pending { method: string, resolve: (value: JsonValue) => void, reject: (error: Error) => void, timer?: ReturnType<typeof setTimeout>, timeout: number, expire: () => void, cleanup: () => void }
const replySchema = z.object({ id: z.string().uuid(), ok: z.boolean(), value: extensionJsonSchema }).strict()
const replyIdentitySchema = z.object({ id: z.string().uuid() })

export class SandboxedExtensionHost implements ExtensionHost {
  readonly window: BrowserWindow
  readonly #pending = new Map<string, Pending>()
  readonly #ready: Promise<void>
  readonly #broker: (method: string, params: unknown) => Promise<JsonValue>
  readonly #cleanup: () => void
  readonly #onFailure: (failure: ExtensionHostFailure) => void
  #resolveReady!: () => void
  #rejectReady!: (error: Error) => void
  #io = 0
  #closing = false
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
    this.#cleanup = () => {
      endpoint.dispose()
      stopProtocol()
      isolated.webRequest.onBeforeRequest(null)
      void isolated.closeAllConnections()
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
      if (this.#closing)
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
      const io = ['network.get', 'network.download', 'resources.importFile', 'themes.request'].includes(method)
      if (io && this.#io++ === 0) {
        for (const pending of this.#pending.values())
          clearTimeout(pending.timer)
      }
      try {
        return await this.#broker(method, params)
      }
      finally {
        if (io && --this.#io === 0 && !this.#closing) {
          for (const pending of this.#pending.values()) {
            if (pending.timeout)
              pending.timer = setTimeout(pending.expire, pending.timeout)
          }
        }
      }
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
    if (this.#closing || this.window.isDestroyed())
      throw new Error('EXTENSION_HOST_STOPPED')
    if (this.#pending.size >= 64)
      throw new Error('EXTENSION_REQUEST_LIMIT')
    return this.#send(method, params, method === 'agent.invoke' ? 0 : 15000, signal)
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

  async dispose(): Promise<void> {
    if (this.#closing)
      return
    this.#closing = true
    this.#rejectAll()
    if (this.#started && !this.window.isDestroyed())
      await this.#send('deactivate', null, 1500).catch(() => {})
    this.#rejectAll()
    this.#closeDeveloperWindow()
    this.#cleanup()
    if (!this.window.isDestroyed())
      this.window.destroy()
  }

  #send(method: string, params: JsonValue, timeout: number, signal?: AbortSignal): Promise<JsonValue> {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const pending = this.#pending
      let entry: Pending
      function cleanup() {
        clearTimeout(entry.timer)
        signal?.removeEventListener('abort', cancel)
      }
      function cancel() {
        cleanup()
        pending.delete(id)
        reject(new Error('EXTENSION_AGENT_CANCELLED'))
      }
      const expire = () => {
        cleanup()
        pending.delete(id)
        reject(new Error('EXTENSION_REQUEST_TIMEOUT'))
        if (method !== 'deactivate')
          this.#fail({ code: 'EXTENSION_REQUEST_TIMEOUT', method, stage: 'timeout' })
      }
      const timer = timeout && (!this.#io || method === 'deactivate') ? setTimeout(expire, timeout) : undefined
      entry = { method, resolve, reject, timer, timeout, expire, cleanup }
      pending.set(id, entry)
      signal?.addEventListener('abort', cancel, { once: true })
      this.window.webContents.send(EXTENSION_IPC.hostMessage, { id, method, params })
    })
  }

  #closeDeveloperWindow(): void {
    const window = this.#developerWindow
    this.#developerWindow = null
    if (window && !window.isDestroyed())
      window.destroy()
  }

  #fail(failure: ExtensionHostFailure = { code: 'EXTENSION_HOST_CRASHED', method: 'unknown', stage: 'process' }): void {
    if (this.#closing)
      return
    this.#rejectAll(failure.code)
    this.#onFailure(failure)
  }

  #rejectAll(readyError = 'EXTENSION_HOST_STOPPED'): void {
    clearTimeout(this.#readyTimer)
    this.#rejectReady(new Error(readyError))
    for (const pending of this.#pending.values()) {
      pending.cleanup()
      pending.reject(new Error('EXTENSION_HOST_STOPPED'))
    }
    this.#pending.clear()
  }
}
