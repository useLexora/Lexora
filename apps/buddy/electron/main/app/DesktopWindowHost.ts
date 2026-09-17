import type { BrowserWindow } from 'electron'
import type { LexoraConfig } from '../../shared/desktopApi'
import type { ExecuteDesktopCommand } from '../desktopCommands'
import type { DesktopEnvironment } from './typing'
import process from 'node:process'
import { app, nativeTheme, screen } from 'electron'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { DesktopWindowManager } from '../DesktopWindowManager'
import { DesktopWindowStateStore, resolveVisibleWindowPlacement } from '../desktopWindowState'
import { resolveDevelopmentRendererUrl } from '../security/navigationPolicy'
import { applyDesktopWindowAppearance, createDesktopWindow } from '../window'
import { observeRendererDiagnostics } from './desktopProcessDiagnostics'

interface WindowBindings {
  executeCommand: ExecuteDesktopCommand
  isQuitting: () => boolean
  onHidden: () => void
  onWindowCreated: (window: BrowserWindow) => void
}

export class DesktopWindowHost {
  readonly #environment: DesktopEnvironment
  #manager: DesktopWindowManager | null = null

  constructor(environment: DesktopEnvironment) {
    this.#environment = environment
  }

  get window(): BrowserWindow | null {
    return this.#manager?.window ?? null
  }

  async initialize(bindings: WindowBindings): Promise<BrowserWindow> {
    const environment = this.#environment
    const stateStore = new DesktopWindowStateStore({
      path: environment.windowStateAvailable ? environment.paths.windowState : null,
      onError: (operation, error) => {
        environment.diagnostics.record({ scope: 'desktop', level: 'warn', event: `window_state.${operation}.failed`, error })
      },
    })
    let placement = resolveVisibleWindowPlacement(
      await stateStore.read(),
      screen.getAllDisplays().map(display => display.bounds),
    )
    const manager = new DesktopWindowManager({
      createWindow: () => {
        const handle = createDesktopWindow({
          appName: environment.paths.appName,
          executeCommand: bindings.executeCommand,
          iconPath: environment.desktopIconPath,
          isQuitting: bindings.isQuitting,
          onHidden() {
            if (!handle.window.webContents.isDestroyed())
              handle.window.webContents.send(DESKTOP_IPC_CHANNELS.appHidden)
            bindings.onHidden()
          },
          onPlacementChanged(next) {
            placement = next
            void stateStore.write(next)
          },
          placement,
          rendererUrl: resolveDevelopmentRendererUrl(process.env.ELECTRON_RENDERER_URL, app.isPackaged),
          showOnReady: false,
        })
        applyDesktopWindowAppearance(handle.window, nativeTheme.shouldUseDarkColors)
        environment.events.publish({ level: 'info', event: 'window.created' })
        handle.window.webContents.once('did-finish-load', () => {
          environment.events.publish({ level: 'info', event: 'window.loaded' })
        })
        handle.window.once('closed', () => {
          environment.events.publish({ level: 'info', event: 'window.closed' })
        })
        handle.window.on('unresponsive', () => {
          environment.events.publish({ level: 'warn', event: 'window.unresponsive' })
        })
        observeRendererDiagnostics(handle.window.webContents, event => environment.events.publish(event))
        bindings.onWindowCreated(handle.window)
        return handle
      },
    })
    this.#manager = manager
    if (!environment.isSmokeTest && environment.initialLaunchIntent === 'foreground')
      await manager.open()
    return manager.window ?? manager.load()
  }

  show(): void {
    void this.#manager?.open().catch((error) => {
      this.#environment.diagnostics.record({ scope: 'desktop', level: 'error', event: 'window.activate_failed', error })
    })
  }

  async openTarget(target: { conversationId: string, runId: string }): Promise<void> {
    if (!this.#manager)
      return
    await this.#manager.open()
    this.window?.webContents.send(DESKTOP_IPC_CHANNELS.appOpenTarget, target)
  }

  updateAppearance(): void {
    if (this.window)
      applyDesktopWindowAppearance(this.window, nativeTheme.shouldUseDarkColors)
  }

  applyConfig(config: LexoraConfig): void {
    nativeTheme.themeSource = config.desktop.theme
    this.updateAppearance()
    const contents = this.window?.webContents
    if (!config.desktop.developerToolsEnabled && contents?.isDevToolsOpened())
      contents.closeDevTools()
  }

  close(): void {
    this.#manager?.dispose()
    this.#manager = null
  }
}
