import { describe, expect, it, vi } from 'vitest'

import { createDesktopWindow } from '../window'

const electron = vi.hoisted(() => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []

    readonly hide = vi.fn()
    readonly maximize = vi.fn()
    readonly removeMenu = vi.fn()
    readonly setTitle = vi.fn()
    readonly show = vi.fn()
    readonly webContents = {
      isDestroyed: () => false,
      on: vi.fn(),
      send: vi.fn(),
      session: {
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
      },
      setWindowOpenHandler: vi.fn(),
    }

    readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    readonly options: Record<string, unknown>

    constructor(options: Record<string, unknown>) {
      this.options = options
      FakeBrowserWindow.instances.push(this)
    }

    getNormalBounds() {
      return { height: 820, width: 1_280, x: 0, y: 0 }
    }

    isDestroyed(): boolean {
      return false
    }

    isMaximized(): boolean {
      return false
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }

    once(event: string, listener: (...args: unknown[]) => void): this {
      return this.on(event, listener)
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? [])
        listener(...args)
    }
  }

  return { FakeBrowserWindow }
})

vi.mock('electron', () => ({
  BrowserWindow: electron.FakeBrowserWindow,
  Menu: {
    buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
  },
  shell: {
    openExternal: vi.fn(),
  },
}))

describe('createDesktopWindow lifecycle', () => {
  it('hides to tray on ordinary close and lets a committed quit close the window', () => {
    let isQuitting = false
    const onHidden = vi.fn()
    createDesktopWindow({
      appName: 'Lexora Buddy Dev',
      iconPath: '/tmp/icon.png',
      isQuitting: () => isQuitting,
      onHidden,
      rendererUrl: null,
    })
    const window = electron.FakeBrowserWindow.instances.at(-1)!
    expect(window.options.title).toBe('Lexora Buddy Dev')
    const pageTitleUpdate = { preventDefault: vi.fn() }
    window.emit('page-title-updated', pageTitleUpdate)
    expect(pageTitleUpdate.preventDefault).toHaveBeenCalledOnce()
    expect(window.setTitle).toHaveBeenCalledWith('Lexora Buddy Dev')
    const ordinaryClose = { preventDefault: vi.fn() }

    window.emit('close', ordinaryClose)

    expect(ordinaryClose.preventDefault).toHaveBeenCalledOnce()
    expect(window.hide).toHaveBeenCalledOnce()
    expect(onHidden).toHaveBeenCalledOnce()

    isQuitting = true
    const quittingClose = { preventDefault: vi.fn() }
    window.emit('close', quittingClose)

    expect(quittingClose.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalledOnce()
  })
})
