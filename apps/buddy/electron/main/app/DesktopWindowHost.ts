import type { BrowserWindow } from 'electron'
import type { LexoraConfig } from '../../shared/desktopApi'
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
  isQuitting: () => boolean
  onHidden: () => void
  onRecoveryExhausted: () => void
  onWindowCreated: (window: BrowserWindow) => void
}

export class DesktopWindowHost {
  readonly #environment: DesktopEnvironment
  #manager: DesktopWindowManager | null = null
  #background = '#fafaf8'
  #themeDark = false
  #onRecoveryExhausted: (() => void) | null = null

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
      onRecoveryStarted: () => environment.events.publish({ level: 'warn', event: 'renderer.recovery.started', attempt: 1 }),
      onRecoveryRebuilding: () => environment.events.publish({ level: 'info', event: 'renderer.recovery.rebuilding', attempt: 1 }),
      onRecoveryExhausted: () => {
        environment.events.publish({ level: 'error', event: 'renderer.recovery.exhausted', attempt: 1 })
        bindings.onRecoveryExhausted()
      },
      createWindow: () => {
        const handle = createDesktopWindow({
          appName: environment.paths.appName,
          backgroundColor: this.#background,
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
        applyDesktopWindowAppearance(handle.window, this.#themeDark)
        handle.window.setBackgroundColor(this.#background)
        environment.events.publish({ level: 'info', event: 'window.created' })
        handle.window.webContents.on('did-finish-load', () => {
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
    this.#onRecoveryExhausted = bindings.onRecoveryExhausted
    if (!environment.isSmokeTest && environment.initialLaunchIntent === 'foreground')
      await manager.open()
    return manager.window ?? manager.load()
  }

  show(): void {
    if (this.#manager?.recoveryExhausted) {
      this.#onRecoveryExhausted?.()
      return
    }
    void this.#manager?.open().catch((error) => {
      this.#environment.diagnostics.record({ scope: 'desktop', level: 'error', event: 'window.activate_failed', error })
    })
  }

  async openTarget(target: { conversationId: string, runId: string }): Promise<void> {
    if (!this.#manager)
      return
    if (this.#manager.recoveryExhausted) {
      this.#onRecoveryExhausted?.()
      return
    }
    await this.#manager.open()
    this.window?.webContents.send(DESKTOP_IPC_CHANNELS.appOpenTarget, target)
  }

  setThemeAppearance(color: string, dark: boolean, system: boolean): void {
    this.#background = color
    this.#themeDark = dark
    nativeTheme.themeSource = system ? 'system' : dark ? 'dark' : 'light'
    this.updateAppearance()
  }

  updateAppearance(): void {
    if (this.window) {
      applyDesktopWindowAppearance(this.window, this.#themeDark)
      this.window.setBackgroundColor(this.#background)
    }
  }

  applyConfig(config: LexoraConfig): void {
    this.updateAppearance()
    const contents = this.window?.webContents
    if (!config.desktop.developerToolsEnabled && contents?.isDevToolsOpened())
      contents.closeDevTools()
  }

  close(): void {
    this.#manager?.dispose()
    this.#manager = null
    this.#onRecoveryExhausted = null
  }
}
