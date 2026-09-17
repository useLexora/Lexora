import type { DesktopBrowserGuestDescriptor } from '../../../shared/desktopApi'
import type { BrowserOperationGuard } from '../BrowserOperationGuard'
import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { vi } from 'vitest'
import { BrowserHost } from '../BrowserHost'

export function createFixture(options: { operations?: BrowserOperationGuard, getDefaultZoomFactor?: () => number, getFreezeDelay?: (visible: boolean) => number | null } = {}) {
  const ids = Array.from({ length: 16 }, (_, index) => (
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
  ))
  const webContentsInstances: FakeWebContents[] = []
  const guestDescriptors: DesktopBrowserGuestDescriptor[] = []
  const createPage = vi.fn((descriptor: DesktopBrowserGuestDescriptor) => {
    guestDescriptors.push(descriptor)
    const webContents = new FakeWebContents(webContentsInstances.length + 1)
    webContentsInstances.push(webContents)
    return webContents
  })
  const window = new FakeWindow()
  const onStateChanged = vi.fn()
  const onSessionClosed = vi.fn()
  const host = new BrowserHost({
    ...options,
    createId: () => ids.shift()!,
    createPage: createPage as never,
    onSessionClosed,
    onStateChanged,
    window: window as never,
  })

  return {
    createPage,
    guestDescriptors,
    host,
    onSessionClosed,
    onStateChanged,
    get webContents() {
      return webContentsInstances[0]!
    },
    webContentsInstances,
    window,
  }
}

export async function createLocalSite(): Promise<{ entryPath: string, rootPath: string }> {
  const rootPath = await createTemporaryDirectory('lexora-browser-host-file-')
  const entryPath = join(rootPath, 'site', 'index.html')
  await mkdir(join(rootPath, 'site'), { recursive: true })
  await writeFile(entryPath, '<h1>Local</h1>')
  return { entryPath, rootPath }
}

class FakeWindow extends EventEmitter {
  visible = true
  readonly webContents = Object.assign(new EventEmitter(), { focus: vi.fn() })

  isDestroyed(): boolean {
    return false
  }

  isVisible(): boolean {
    return this.visible
  }
}

class FakeWebContents extends EventEmitter {
  readonly id: number
  canNavigateBack = false
  canNavigateForward = false
  currentUrl = 'about:blank'
  debuggerAttached = false
  title = ''
  audible = false
  lifecycleState: 'active' | 'frozen' = 'active'
  isCurrentlyAudible = () => this.audible
  backgroundThrottling = true
  getBackgroundThrottling = () => this.backgroundThrottling
  setBackgroundThrottling = (allowed: boolean) => { this.backgroundThrottling = allowed }
  zoomFactor = 1
  getZoomFactor = () => this.zoomFactor
  setZoomFactor = (factor: number) => { this.zoomFactor = factor }
  setZoomMode = vi.fn()
  readonly close = vi.fn()
  readonly capturePage = vi.fn(async () => ({
    getSize: () => ({ height: 600, width: 800 }),
    toPNG: () => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
  }))

  readonly debugger = {
    attach: vi.fn(() => {
      this.debuggerAttached = true
    }),
    detach: vi.fn(() => {
      this.debuggerAttached = false
    }),
    isAttached: vi.fn(() => this.debuggerAttached),
    sendCommand: vi.fn<(
      method: string,
      commandParams?: Record<string, unknown>,
    ) => Promise<unknown>>(async (method, params) => {
      if (method === 'Page.setWebLifecycleState')
        this.lifecycleState = params?.state as 'active' | 'frozen'
      return {}
    }),
  }

  readonly focus = vi.fn()
  readonly loadURL = vi.fn(async (url: string) => {
    this.currentUrl = url
  })

  readonly navigationHistory = {
    canGoBack: () => this.canNavigateBack,
    canGoForward: () => this.canNavigateForward,
    getActiveIndex: () => 1,
    getEntryAtIndex: (index: number) => index === 0 ? { url: 'about:blank' } : null,
    goBack: vi.fn(),
    goForward: vi.fn(),
    removeEntryAtIndex: vi.fn(() => true),
  }

  readonly reload = vi.fn()
  readonly session = new FakeBrowserSession()
  readonly setWindowOpenHandler = vi.fn()
  readonly stop = vi.fn()

  constructor(id: number) {
    super()
    this.id = id
  }

  getTitle(): string {
    return this.title
  }

  getURL(): string {
    return this.currentUrl
  }

  isDestroyed(): boolean {
    return false
  }
}

export function configureSemanticObservation(webContents: FakeWebContents): void {
  webContents.debugger.sendCommand.mockImplementation(async (method) => {
    if (method === 'Page.getFrameTree') {
      return {
        frameTree: {
          frame: {
            id: 'main-frame',
            url: webContents.currentUrl,
          },
        },
      }
    }
    if (method === 'DOM.getDocument')
      return { root: { frameId: 'main-frame' } }
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [{
          backendDOMNodeId: 1,
          frameId: 'main-frame',
          ignored: false,
          name: { type: 'computedString', value: 'Application' },
          nodeId: 'ax-1',
          role: { type: 'role', value: 'RootWebArea' },
        }, {
          backendDOMNodeId: 2,
          ignored: false,
          name: { type: 'computedString', value: 'Open report' },
          nodeId: 'ax-2',
          role: { type: 'role', value: 'button' },
        }],
      }
    }
    if (method === 'DOMSnapshot.captureSnapshot') {
      return {
        documents: [{
          frameId: 0,
          layout: {
            bounds: [[0, 0, 800, 600], [20, 20, 120, 32]],
            nodeIndex: [0, 1],
            text: [3, 4],
          },
          nodes: {
            backendNodeId: [1, 2],
            nodeName: [1, 2],
          },
        }],
        strings: ['main-frame', '#document', 'BUTTON', 'Application', 'Open report'],
      }
    }
    if (method === 'Page.getLayoutMetrics') {
      return {
        cssVisualViewport: {
          clientHeight: 600,
          clientWidth: 800,
          pageX: 0,
          pageY: 0,
        },
      }
    }
    if (method === 'DOM.resolveNode') {
      return {
        object: {
          objectId: 'target-object',
          type: 'object',
        },
      }
    }
    if (method === 'Runtime.callFunctionOn') {
      return {
        result: {
          type: 'object',
          value: {
            connected: true,
            covered: false,
            disabled: false,
            editable: false,
            fieldMetadata: {
              ariaLabel: '',
              autocomplete: '',
              id: '',
              label: '',
              name: '',
              placeholder: '',
              type: '',
            },
            focusable: true,
            readOnly: false,
            selectable: false,
            stable: true,
            visible: true,
          },
        },
      }
    }
    if (method === 'DOM.getBoxModel') {
      return {
        model: {
          border: [20, 20, 140, 20, 140, 52, 20, 52],
          content: [20, 20, 140, 20, 140, 52, 20, 52],
        },
      }
    }
    return {}
  })
}

export function configureSensitiveSemanticObservation(webContents: FakeWebContents): void {
  configureSemanticObservation(webContents)
  const respond = webContents.debugger.sendCommand.getMockImplementation()!
  webContents.debugger.sendCommand.mockImplementation(async (method, commandParams) => {
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [{
          backendDOMNodeId: 1,
          frameId: 'main-frame',
          ignored: false,
          name: { type: 'computedString', value: 'Sign in' },
          nodeId: 'ax-1',
          role: { type: 'role', value: 'RootWebArea' },
        }, {
          backendDOMNodeId: 2,
          ignored: false,
          name: { type: 'computedString', value: 'Password' },
          nodeId: 'ax-2',
          properties: [{
            name: 'editable',
            value: { type: 'token', value: 'plaintext' },
          }],
          role: { type: 'role', value: 'textbox' },
          value: { type: 'string', value: 'private-value' },
        }],
      }
    }
    if (method === 'DOMSnapshot.captureSnapshot') {
      return {
        documents: [{
          frameId: 0,
          layout: {
            bounds: [[0, 0, 800, 600], [20, 20, 180, 32]],
            nodeIndex: [0, 1],
          },
          nodes: {
            attributes: [[], [1, 2]],
            backendNodeId: [1, 2],
            nodeName: [3, 4],
          },
        }],
        strings: ['main-frame', 'type', 'password', '#document', 'INPUT'],
      }
    }
    return respond(method, commandParams)
  })
}

class FakeBrowserSession extends EventEmitter {
  readonly clearCache = vi.fn(async () => {})
  readonly clearStorageData = vi.fn(async () => {})
  readonly flushStorageData = vi.fn()
  permissionRequestHandler: null | ((
    webContents: unknown,
    permission: unknown,
    callback: (allowed: boolean) => void,
  ) => void) = null

  readonly resolutions = new Map<string, string[]>()
  readonly resolveProxy = vi.fn(async () => 'DIRECT')
  readonly resolveHost = vi.fn(async (hostname: string) => ({
    endpoints: (this.resolutions.get(hostname) ?? ['93.184.216.34']).map(address => ({
      address,
      family: address.includes(':') ? 'ipv6' : 'ipv4',
    })),
  }))

  readonly setPermissionCheckHandler = vi.fn()
  readonly setPermissionRequestHandler = vi.fn((handler: typeof this.permissionRequestHandler) => {
    this.permissionRequestHandler = handler
  })

  readonly webRequest = {
    onBeforeRequest: vi.fn(),
  }
}
