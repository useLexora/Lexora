import type { BrowserWindowConstructorOptions } from 'electron'
import type { DesktopWindowState } from '../shared/desktopApi'
import type { DesktopWindowPlacement } from './desktopWindowState'
import { join } from 'node:path'
import { BrowserWindow, Menu, shell } from 'electron'
import { DESKTOP_IPC_CHANNELS } from '../shared/desktopApi'
import { createDesktopContextMenuTemplate } from './desktopContextMenu'
import { isAllowedExternalUrl, isAllowedRendererNavigation } from './security/navigationPolicy'

export interface CreateDesktopWindowOptions {
  appName: string
  iconPath: string
  isQuitting: () => boolean
  minimizeToTrayOnClose: () => boolean
  onCloseToQuit: () => void
  onHidden?: () => void
  onPlacementChanged?: (placement: DesktopWindowPlacement) => void
  placement?: DesktopWindowPlacement | null
  rendererUrl: string | null
  showOnReady?: boolean
}

export interface DesktopWindowHandle {
  load: () => Promise<void>
  window: BrowserWindow
}

const DARK_WINDOW_BACKGROUND = '#171816'
const LIGHT_WINDOW_BACKGROUND = '#f5f4f1'

export function createDesktopWindow(options: CreateDesktopWindowOptions): DesktopWindowHandle {
  const windowOptions: BrowserWindowConstructorOptions = {
    width: options.placement?.width ?? 1280,
    height: options.placement?.height ?? 820,
    x: options.placement?.x,
    y: options.placement?.y,
    minWidth: 980,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: LIGHT_WINDOW_BACKGROUND,
    frame: false,
    icon: options.iconPath,
    show: false,
    title: options.appName,
    webPreferences: {
      devTools: true,
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: true,
      allowRunningInsecureContent: false,
    },
  }
  const window = new BrowserWindow(windowOptions)
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(options.appName)
  })
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  window.removeMenu()
  let trustedRendererUrl = ''

  const publishWindowState = () => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(
        DESKTOP_IPC_CHANNELS.windowStateChanged,
        readDesktopWindowState(window),
      )
    }
  }
  let placementTimer: ReturnType<typeof setTimeout> | null = null
  const publishPlacement = () => {
    if (!options.onPlacementChanged)
      return
    if (placementTimer)
      clearTimeout(placementTimer)
    placementTimer = setTimeout(() => {
      placementTimer = null
      if (window.isDestroyed())
        return
      options.onPlacementChanged?.({
        ...window.getNormalBounds(),
        maximized: window.isMaximized(),
      })
    }, 250)
  }

  window.on('maximize', publishWindowState)
  window.on('unmaximize', publishWindowState)
  window.on('maximize', publishPlacement)
  window.on('move', publishPlacement)
  window.on('resize', publishPlacement)
  window.on('unmaximize', publishPlacement)
  window.once('closed', () => {
    if (placementTimer)
      clearTimeout(placementTimer)
  })

  window.on('close', (event) => {
    if (options.isQuitting())
      return

    event.preventDefault()
    if (options.minimizeToTrayOnClose()) {
      window.hide()
      options.onHidden?.()
    }
    else {
      options.onCloseToQuit()
    }
  })

  window.once('ready-to-show', () => {
    if (options.placement?.maximized)
      window.maximize()
    if (options.showOnReady !== false)
      window.show()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url))
      void shell.openExternal(url)

    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowedRendererNavigation(url, trustedRendererUrl))
      return

    event.preventDefault()
    if (isAllowedExternalUrl(url))
      void shell.openExternal(url)
  })

  window.webContents.on('context-menu', (_event, params) => {
    const template = createDesktopContextMenuTemplate({
      isEditable: params.isEditable,
      selectionText: params.selectionText,
    })
    if (template.length > 0)
      Menu.buildFromTemplate(template).popup({ window })
  })

  return {
    window,
    async load() {
      if (options.rendererUrl) {
        trustedRendererUrl = new URL('/', options.rendererUrl).toString()
        await window.loadURL(`${trustedRendererUrl}#/tasks`)
        return
      }

      trustedRendererUrl = 'lexora-app://renderer/index.html'
      await window.loadURL(`${trustedRendererUrl}#/tasks`)
    },
  }
}

export function applyDesktopWindowAppearance(window: BrowserWindow, dark: boolean): void {
  const color = dark ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND
  window.setBackgroundColor(color)
}

export function readDesktopWindowState(window: BrowserWindow): DesktopWindowState {
  return {
    isMaximized: window.isMaximized(),
  }
}
