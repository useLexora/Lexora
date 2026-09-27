import type { BrowserWindow } from 'electron'
import type { DesktopWindowHandle } from './window'

export interface DesktopWindowManagerOptions {
  createWindow: () => DesktopWindowHandle
  onRecoveryExhausted?: () => void
  onRecoveryRebuilding?: () => void
  onRecoveryStarted?: () => void
}

interface ManagedDesktopWindow {
  handle: DesktopWindowHandle
  loadPromise: Promise<void> | null
  rendererAvailable: boolean
}

export class DesktopWindowManager {
  readonly #createWindow: () => DesktopWindowHandle
  readonly #onRecoveryExhausted?: () => void
  readonly #onRecoveryRebuilding?: () => void
  readonly #onRecoveryStarted?: () => void
  #managedWindow: ManagedDesktopWindow | null = null
  #initialLoadCompleted = false
  #automaticRecoveryUsed = false
  #recoveryExhausted = false
  #disposed = false

  constructor(options: DesktopWindowManagerOptions) {
    this.#createWindow = options.createWindow
    this.#onRecoveryExhausted = options.onRecoveryExhausted
    this.#onRecoveryRebuilding = options.onRecoveryRebuilding
    this.#onRecoveryStarted = options.onRecoveryStarted
  }

  get recoveryExhausted(): boolean {
    return this.#recoveryExhausted
  }

  get window(): BrowserWindow | null {
    const managedWindow = this.#managedWindow
    if (
      !managedWindow
      || !managedWindow.rendererAvailable
      || managedWindow.handle.window.isDestroyed()
    ) {
      return null
    }
    return managedWindow.handle.window
  }

  async load(): Promise<BrowserWindow> {
    if (this.#disposed || this.#recoveryExhausted)
      throw new Error('Lexora Buddy Desktop renderer recovery is unavailable')
    let managedWindow = this.#managedWindow
    if (!managedWindow || managedWindow.handle.window.isDestroyed()) {
      managedWindow = this.#replaceWindow()
    }

    if (managedWindow.rendererAvailable) {
      managedWindow.loadPromise ??= managedWindow.handle.load().catch((error) => {
        if (this.#managedWindow === managedWindow) {
          this.#managedWindow = null
          if (!managedWindow.handle.window.isDestroyed())
            managedWindow.handle.window.destroy()
        }
        throw error
      })
    }
    if (!managedWindow.loadPromise)
      throw new Error('Lexora Buddy Desktop renderer is recovering')
    await managedWindow.loadPromise

    if (
      this.#disposed
      || this.#recoveryExhausted
      || this.#managedWindow !== managedWindow
      || !managedWindow.rendererAvailable
      || managedWindow.handle.window.isDestroyed()
    ) {
      throw new Error('Lexora Buddy Desktop renderer exited while loading')
    }
    this.#initialLoadCompleted = true
    return managedWindow.handle.window
  }

  async open(): Promise<void> {
    const window = await this.load()
    if (window.isMinimized())
      window.restore()
    window.show()
    window.focus()
  }

  dispose(): void {
    this.#disposed = true
    const managedWindow = this.#managedWindow
    this.#managedWindow = null
    if (managedWindow && !managedWindow.handle.window.isDestroyed())
      managedWindow.handle.window.destroy()
  }

  #replaceWindow(): ManagedDesktopWindow {
    const previousWindow = this.#managedWindow
    this.#managedWindow = null
    if (previousWindow && !previousWindow.handle.window.isDestroyed())
      previousWindow.handle.window.destroy()

    const handle = this.#createWindow()
    const managedWindow: ManagedDesktopWindow = {
      handle,
      loadPromise: null,
      rendererAvailable: true,
    }
    this.#managedWindow = managedWindow
    handle.window.once('closed', () => {
      if (this.#managedWindow === managedWindow)
        this.#managedWindow = null
    })
    handle.window.webContents.on('render-process-gone', (_event, details) => {
      if (this.#managedWindow !== managedWindow || this.#disposed)
        return
      managedWindow.rendererAvailable = false
      if (!this.#initialLoadCompleted || details?.reason === 'clean-exit')
        return
      if (this.#automaticRecoveryUsed) {
        this.#exhaustRecovery()
        return
      }
      this.#automaticRecoveryUsed = true
      this.#onRecoveryStarted?.()
      managedWindow.loadPromise = this.#reloadRenderer(managedWindow).catch(() => this.#exhaustRecovery())
    })
    return managedWindow
  }

  #reloadRenderer(managedWindow: ManagedDesktopWindow): Promise<void> {
    const contents = managedWindow.handle.window.webContents
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>
      let onLoaded: () => void
      let onFailed: () => void
      let onExited: () => void
      let settled = false
      const finish = (error?: Error) => {
        if (settled)
          return
        settled = true
        clearTimeout(timeout)
        contents.off('did-finish-load', onLoaded)
        contents.off('did-fail-load', onFailed)
        contents.off('render-process-gone', onExited)
        if (error) {
          reject(error)
        }
        else {
          managedWindow.rendererAvailable = true
          resolve()
        }
      }
      onLoaded = () => finish()
      onFailed = () => finish(new Error('Desktop renderer reload failed'))
      onExited = () => finish(new Error('Desktop renderer exited while reloading'))
      contents.once('did-finish-load', onLoaded)
      contents.once('did-fail-load', onFailed)
      contents.once('render-process-gone', onExited)
      timeout = setTimeout(() => finish(new Error('Desktop renderer reload timed out')), 15_000)
      setTimeout(() => {
        if (this.#disposed || this.#recoveryExhausted) {
          finish(new Error('Desktop renderer reload cancelled'))
          return
        }
        this.#onRecoveryRebuilding?.()
        try {
          managedWindow.rendererAvailable = true
          contents.reload()
        }
        catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      }, 0)
    })
  }

  #exhaustRecovery(): void {
    if (this.#disposed || this.#recoveryExhausted)
      return
    this.#recoveryExhausted = true
    const managedWindow = this.#managedWindow
    this.#managedWindow = null
    if (managedWindow && !managedWindow.handle.window.isDestroyed())
      managedWindow.handle.window.destroy()
    this.#onRecoveryExhausted?.()
  }
}
