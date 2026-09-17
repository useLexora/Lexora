import type { BrowserFailureReason } from '../../../shared/browser'
import type { DesktopBrowserErrorCode } from '../../../shared/browser/browserDesktopApi'
import { isIP } from 'node:net'
import { extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { containsCanonicalPath } from '../../../platform/filesystem/filePaths'
import { resolveFilePath } from '../../../platform/filesystem/resolveFilePath'
import { BrowserDebugger } from './BrowserDebugger'

export interface BrowserSecurityPage {
  id: number
  debugger: {
    attach: (protocolVersion?: string) => void
    detach: () => void
    isAttached: () => boolean
    sendCommand: (
      method: string,
      commandParams?: Record<string, unknown>,
    ) => Promise<unknown>
  }
  getURL: () => string
  loadURL: (url: string) => Promise<unknown>
  setWindowOpenHandler: (handler: () => { action: 'deny' }) => void
  on: (event: 'certificate-error', listener: CertificateErrorListener) => unknown
  off: (event: 'certificate-error', listener: CertificateErrorListener) => unknown
}

export interface BrowserSecuritySession {
  off: (event: 'will-download', listener: DownloadListener) => unknown
  on: (event: 'will-download', listener: DownloadListener) => unknown
  setPermissionCheckHandler: (
    handler: null | (() => boolean),
  ) => void
  setPermissionRequestHandler: (
    handler: null | ((
      webContents: unknown,
      permission: unknown,
      callback: (allowed: boolean) => void,
    ) => void),
  ) => void
  webRequest: {
    onBeforeRequest: {
      (listener: BeforeRequestListener | null): void
      (filter: { urls: string[] }, listener: BeforeRequestListener | null): void
    }
  }
}

interface BrowserSecurityPolicyOptions {
  connection?: BrowserDebugger
  onCertificateError?: (details: BrowserCertificateErrorDetails) => void
  onPermissionDenied?: () => void
  onRequestBlocked?: (details: BrowserRequestDetails) => void
  page: BrowserSecurityPage
  session: BrowserSecuritySession
}

interface BrowserRequestDetails {
  resourceType: string
  url: string
  webContentsId?: number
}

interface BrowserCertificateErrorDetails {
  error: string
  url: string
}

interface DownloadEvent {
  preventDefault: () => void
}

type DownloadListener = (
  event: DownloadEvent,
  item: unknown,
  webContents: unknown,
) => void

type CertificateErrorListener = (
  event: unknown,
  url: string,
  error: string,
  certificate: unknown,
  callback: (isTrusted: boolean) => void,
  isMainFrame: boolean,
) => void

type BeforeRequestListener = (
  details: BrowserRequestDetails,
  callback: (response: { cancel: boolean }) => void,
) => void

interface BrowserSecurityRoute {
  isRequestAllowed: (details: BrowserRequestDetails) => Promise<boolean>
  onPermissionDenied: () => void
  onRequestBlocked: (details: BrowserRequestDetails) => void
}

const sessionSecurityCoordinators = new WeakMap<
  BrowserSecuritySession,
  BrowserSecuritySessionCoordinator
>()

class BrowserSecuritySessionCoordinator {
  readonly #beforeRequestListener: BeforeRequestListener
  readonly #downloadListener: DownloadListener
  readonly #routes = new Map<number, BrowserSecurityRoute>()
  readonly #session: BrowserSecuritySession

  constructor(session: BrowserSecuritySession) {
    this.#session = session
    this.#beforeRequestListener = (details, callback) => {
      const route = details.webContentsId === undefined ? undefined : this.#routes.get(details.webContentsId)
      if (!route) {
        callback({ cancel: true })
        return
      }
      void route.isRequestAllowed(details).then((allowed) => {
        if (!allowed)
          route.onRequestBlocked(details)
        callback({ cancel: !allowed })
      }).catch(() => {
        route.onRequestBlocked(details)
        callback({ cancel: true })
      })
    }
    this.#downloadListener = event => event.preventDefault()
    this.#session.setPermissionCheckHandler(() => false)
    this.#session.setPermissionRequestHandler((webContents, _permission, callback) => {
      callback(false)
      this.#routes.get(readWebContentsId(webContents))?.onPermissionDenied()
    })
    this.#session.webRequest.onBeforeRequest(
      { urls: ['*://*/*', 'file://*/*'] },
      this.#beforeRequestListener,
    )
    this.#session.on('will-download', this.#downloadListener)
  }

  register(pageId: number, route: BrowserSecurityRoute): () => boolean {
    if (this.#routes.has(pageId))
      throw new Error(`Browser security route already exists: ${pageId}`)
    this.#routes.set(pageId, route)
    return () => {
      this.#routes.delete(pageId)
      if (this.#routes.size > 0)
        return false
      this.#session.setPermissionCheckHandler(null)
      this.#session.setPermissionRequestHandler(null)
      this.#session.webRequest.onBeforeRequest(null)
      this.#session.off('will-download', this.#downloadListener)
      return true
    }
  }
}

function registerBrowserSecurityRoute(
  session: BrowserSecuritySession,
  pageId: number,
  route: BrowserSecurityRoute,
): () => void {
  const coordinator = sessionSecurityCoordinators.get(session)
    ?? new BrowserSecuritySessionCoordinator(session)
  sessionSecurityCoordinators.set(session, coordinator)
  const unregister = coordinator.register(pageId, route)
  return () => {
    if (unregister())
      sessionSecurityCoordinators.delete(session)
  }
}

function readWebContentsId(value: unknown): number {
  if (
    typeof value === 'object'
    && value !== null
    && 'id' in value
    && typeof value.id === 'number'
  ) {
    return value.id
  }
  return -1
}

export class BrowserSecurityPolicyError extends Error {
  readonly code: DesktopBrowserErrorCode = 'BROWSER_NAVIGATION_BLOCKED'
  readonly reason: BrowserFailureReason

  constructor(reason: BrowserFailureReason, message: string) {
    super(message)
    this.name = 'BrowserSecurityPolicyError'
    this.reason = reason
  }
}

export class BrowserSecurityPolicy {
  readonly #certificateErrorListener: CertificateErrorListener
  readonly #onCertificateError: (details: BrowserCertificateErrorDetails) => void
  readonly #onPermissionDenied: () => void
  readonly #onRequestBlocked: (details: BrowserRequestDetails) => void
  readonly #page: BrowserSecurityPage
  readonly #releaseSessionPolicy: () => void
  readonly #session: BrowserSecuritySession
  #disposed = false
  #fileChooserGuardPromise: Promise<void> | null = null
  #localFileRoot: string | null = null
  readonly #connection: BrowserDebugger
  readonly #ownsConnection: boolean

  constructor(options: BrowserSecurityPolicyOptions) {
    this.#onCertificateError = options.onCertificateError ?? (() => {})
    this.#onPermissionDenied = options.onPermissionDenied ?? (() => {})
    this.#onRequestBlocked = options.onRequestBlocked ?? (() => {})
    this.#page = options.page
    this.#connection = options.connection ?? new BrowserDebugger(options.page.debugger)
    this.#ownsConnection = !options.connection
    this.#session = options.session
    this.#releaseSessionPolicy = registerBrowserSecurityRoute(
      this.#session,
      this.#page.id,
      {
        isRequestAllowed: details => this.#isRequestAllowed(details),
        onPermissionDenied: () => this.#onPermissionDenied(),
        onRequestBlocked: details => this.#onRequestBlocked(details),
      },
    )
    this.#certificateErrorListener = (_event, url, error, _certificate, callback, isMainFrame) => {
      callback(false)
      if (isMainFrame)
        this.#onCertificateError({ error: error.slice(0, 1_024), url })
    }
    this.#page.on('certificate-error', this.#certificateErrorListener)
    this.#page.setWindowOpenHandler(() => ({ action: 'deny' }))
  }

  async authorizeNavigation(rawUrl: string): Promise<string> {
    this.#assertActive()
    await this.#ensureFileChooserGuard()
    const url = parseBrowserUrl(rawUrl)
    if (!url || url.username || url.password) {
      throw new BrowserSecurityPolicyError(
        'INVALID_TARGET',
        'Browser navigation target is invalid',
      )
    }

    this.#localFileRoot = null
    return url.toString()
  }

  async authorizeLocalFile(entryPath: string, rootPath: string): Promise<string> {
    this.#assertActive()
    await this.#ensureFileChooserGuard()
    let entry: string
    let root: string
    try {
      const [entryResolution, rootResolution] = await Promise.all([
        resolveFilePath(entryPath, 'existing'),
        resolveFilePath(rootPath, 'existing'),
      ])
      entry = entryResolution.canonicalPath
      root = rootResolution.canonicalPath
      const extension = extname(entry).toLowerCase()
      if (
        !entryResolution.isFile
        || !rootResolution.isDirectory
        || (extension !== '.html' && extension !== '.htm')
        || !containsCanonicalPath(root, entry)
      ) {
        throw new Error('invalid local file')
      }
    }
    catch {
      throw new BrowserSecurityPolicyError(
        'INVALID_TARGET',
        'Browser local file target is invalid',
      )
    }
    this.#localFileRoot = root
    return pathToFileURL(entry).toString()
  }

  dispose(): void {
    if (this.#disposed)
      return
    this.#disposed = true
    this.#releaseSessionPolicy()
    this.#page.off('certificate-error', this.#certificateErrorListener)
    if (this.#ownsConnection)
      this.#connection.dispose()
    this.#localFileRoot = null
  }

  #assertActive(): void {
    if (this.#disposed)
      throw new Error('Browser security policy is disposed')
  }

  async #ensureFileChooserGuard(): Promise<void> {
    if (!this.#fileChooserGuardPromise)
      this.#fileChooserGuardPromise = this.#installFileChooserGuard()
    try {
      await this.#fileChooserGuardPromise
    }
    catch {
      if (this.#ownsConnection)
        this.#connection.dispose()
      throw new BrowserSecurityPolicyError(
        'FILE_CHOOSER_GUARD_UNAVAILABLE',
        'Browser file chooser guard is unavailable',
      )
    }
  }

  async #installFileChooserGuard(): Promise<void> {
    if (!this.#page.getURL())
      await this.#page.loadURL('about:blank')
    this.#connection.ensureAttached()
    await this.#connection.sendCommand('Page.enable')
    await this.#connection.sendCommand(
      'Page.setInterceptFileChooserDialog',
      { cancel: true, enabled: true },
    )
  }

  async #isRequestAllowed(details: BrowserRequestDetails): Promise<boolean> {
    if (this.#disposed)
      return false
    const url = parseBrowserUrl(details.url, true)
    if (!url)
      return false

    if (url.protocol === 'blob:' || url.protocol === 'data:')
      return details.resourceType !== 'mainFrame'

    if (url.protocol === 'file:')
      return this.#isLocalFileAllowed(url)

    if (this.#localFileRoot !== null && details.resourceType !== 'mainFrame')
      return false

    const isWebRequest = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
    if (!isWebRequest || url.username || url.password)
      return false
    if (details.resourceType === 'mainFrame')
      this.#localFileRoot = null
    return true
  }

  async #isLocalFileAllowed(url: URL): Promise<boolean> {
    if (!this.#localFileRoot)
      return false
    try {
      const path = await resolveFilePath(fileURLToPath(url), 'existing')
      return path.isFile && containsCanonicalPath(this.#localFileRoot, path.canonicalPath)
    }
    catch {
      return false
    }
  }
}

function isLoopbackUrl(url: URL): boolean {
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol))
    return false
  const hostname = normalizeHostname(url.hostname)
  if (hostname === 'localhost')
    return true
  return isIP(hostname) > 0 && isLoopbackIpAddress(hostname)
}

export function isLoopbackBrowserUrl(rawUrl: string): boolean {
  const url = parseBrowserUrl(rawUrl)
  return Boolean(url && isLoopbackUrl(url))
}

function isLoopbackIpAddress(rawAddress: string): boolean {
  const address = normalizeHostname(rawAddress)
  if (isIP(address) === 4)
    return address.startsWith('127.')
  if (isIP(address) !== 6)
    return false
  const mappedIpv4 = readMappedIpv4(address)
  return mappedIpv4 ? isLoopbackIpAddress(mappedIpv4) : address === '::1'
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function parseBrowserUrl(rawUrl: string, allowSubresourceSchemes = false): URL | null {
  try {
    const url = new URL(rawUrl)
    const allowedProtocols = allowSubresourceSchemes
      ? ['blob:', 'data:', 'file:', 'http:', 'https:', 'ws:', 'wss:']
      : ['http:', 'https:']
    return allowedProtocols.includes(url.protocol) ? url : null
  }
  catch {
    return null
  }
}

function readMappedIpv4(address: string): string | null {
  const dotted = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1]
  if (dotted)
    return dotted
  const hexadecimal = address.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/)
  if (!hexadecimal)
    return null
  const high = Number.parseInt(hexadecimal[1], 16)
  const low = Number.parseInt(hexadecimal[2], 16)
  return `${high >>> 8}.${high & 0xFF}.${low >>> 8}.${low & 0xFF}`
}
