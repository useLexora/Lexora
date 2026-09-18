import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { ExtensionPackage } from '../../../platform/extensions/ExtensionPackageStore'
import type { ExtensionHost } from '../../../platform/extensions/ExtensionService'
import type { JsonValue } from '../../../shared/workbench/workbenchState'
import type { ExtensionProtocol } from './ExtensionProtocol'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BrowserWindow, session } from 'electron'
import { z } from 'zod'
import { EXTENSION_IPC, extensionError, extensionJsonSchema } from '../../../shared/extensions/extensionApi'

interface Pending { resolve: (value: JsonValue) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }
const replySchema = z.object({ id: z.string().uuid(), ok: z.boolean(), value: extensionJsonSchema }).strict()

export class SandboxedExtensionHost implements ExtensionHost {
  readonly window: BrowserWindow
  readonly #pending = new Map<string, Pending>()
  readonly #ready: Promise<void>
  readonly #broker: (method: string, params: unknown) => Promise<JsonValue>
  readonly #cleanup: () => void
  readonly #onFailure: () => void
  #resolveReady!: () => void
  #rejectReady!: (error: Error) => void
  #closing = false
  #started = false
  #developerWindow: BrowserWindow | null = null
  #readyTimer: ReturnType<typeof setTimeout>

  constructor(pkg: ExtensionPackage, protocol: ExtensionProtocol, broker: (method: string, params: unknown) => Promise<JsonValue>, failed: () => void) {
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
    this.#readyTimer = setTimeout(() => this.#fail(failed), 15000)
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
    contents.on('render-process-gone', () => this.#fail(failed))
    contents.on('unresponsive', () => this.#fail(failed))
    contents.on('devtools-closed', () => this.#closeDeveloperWindow())
    this.window.on('closed', () => this.#fail(failed))
    void this.window.loadURL(endpoint.url).catch(() => this.#fail(failed))
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
      return await this.#broker(method, extensionJsonSchema.parse(params))
    }
    catch (error) {
      throw new Error(extensionError(error))
    }
  }

  reply(raw: unknown): void {
    const parsed = replySchema.safeParse(raw)
    if (!parsed.success)
      return
    const { id, ok, value } = parsed.data
    const pending = this.#pending.get(id)
    if (!pending)
      return
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    if (ok)
      pending.resolve(value)
    else pending.reject(new Error(typeof value === 'string' && /^EXTENSION_[A-Z_]+$/.test(value) ? value : 'EXTENSION_OPERATION_FAILED'))
  }

  async call(method: string, params: JsonValue): Promise<JsonValue> {
    await this.#ready
    if (this.#closing || this.window.isDestroyed())
      throw new Error('EXTENSION_HOST_STOPPED')
    if (this.#pending.size >= 64)
      throw new Error('EXTENSION_REQUEST_LIMIT')
    return this.#send(method, params, 15000)
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

  #send(method: string, params: JsonValue, timeout: number): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('EXTENSION_REQUEST_TIMEOUT'))
        if (method !== 'deactivate')
          this.#fail(this.#onFailure)
      }, timeout)
      this.#pending.set(id, { resolve, reject, timer })
      this.window.webContents.send(EXTENSION_IPC.hostMessage, { id, method, params })
    })
  }

  #closeDeveloperWindow(): void {
    const window = this.#developerWindow
    this.#developerWindow = null
    if (window && !window.isDestroyed())
      window.destroy()
  }

  #fail(failed: () => void): void {
    if (this.#closing)
      return
    this.#rejectAll()
    failed()
  }

  #rejectAll(): void {
    clearTimeout(this.#readyTimer)
    this.#rejectReady(new Error('EXTENSION_HOST_STOPPED'))
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('EXTENSION_HOST_STOPPED'))
    }
    this.#pending.clear()
  }
}
