import type { BrowserWindow } from 'electron'
import type { DesktopWindowHandle } from '../window'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { DesktopWindowManager } from '../DesktopWindowManager'

class FakeWindow extends EventEmitter {
  readonly focus = vi.fn()
  readonly restore = vi.fn()
  readonly show = vi.fn()
  readonly webContents = Object.assign(new EventEmitter(), { reload: vi.fn() })
  destroyed = false
  minimized = false
  visible = false

  destroy(): void {
    this.destroyed = true
    this.emit('closed')
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isVisible(): boolean {
    return this.visible
  }
}

describe('desktopWindowManager', () => {
  it('rebuilds the renderer once and stops after a second crash even when loading succeeded', async () => {
    const windows: FakeWindow[] = []
    const loads: Array<ReturnType<typeof vi.fn>> = []
    const onRecoveryStarted = vi.fn()
    const onRecoveryExhausted = vi.fn()
    const manager = new DesktopWindowManager({
      onRecoveryStarted,
      onRecoveryExhausted,
      createWindow() {
        const window = new FakeWindow()
        window.show.mockImplementation(() => {
          window.visible = true
        })
        const load = vi.fn().mockResolvedValue(undefined)
        windows.push(window)
        loads.push(load)
        return {
          load,
          window: window as unknown as BrowserWindow,
        } satisfies DesktopWindowHandle
      },
    })

    await manager.open()
    windows[0]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await vi.waitFor(() => expect(windows[0]!.webContents.reload).toHaveBeenCalledOnce())
    expect(onRecoveryStarted).toHaveBeenCalledOnce()
    expect(windows[0]!.destroyed).toBe(false)
    expect(loads[0]).toHaveBeenCalledOnce()
    windows[0]!.webContents.emit('did-finish-load')
    await vi.waitFor(() => expect(manager.window).toBe(windows[0]))
    windows[0]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(manager.recoveryExhausted).toBe(true)
    expect(onRecoveryExhausted).toHaveBeenCalledOnce()
    expect(windows).toHaveLength(1)
    expect(windows[0]!.destroyed).toBe(true)
    await expect(manager.open()).rejects.toThrow('recovery is unavailable')
    expect(windows).toHaveLength(1)
    manager.dispose()
    expect(manager.window).toBeNull()
  })

  it('keeps a hidden window hidden during the single automatic recovery', async () => {
    const windows: FakeWindow[] = []
    const manager = new DesktopWindowManager({
      createWindow() {
        const window = new FakeWindow()
        windows.push(window)
        return { load: vi.fn().mockResolvedValue(undefined), window: window as unknown as BrowserWindow }
      },
    })
    await manager.load()
    windows[0]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await vi.waitFor(() => expect(windows[0]!.webContents.reload).toHaveBeenCalledOnce())
    expect(windows).toHaveLength(1)
    expect(windows[0]!.show).not.toHaveBeenCalled()
    manager.dispose()
  })

  it('enters recovery when reloading the renderer fails', async () => {
    const windows: FakeWindow[] = []
    const onRecoveryExhausted = vi.fn()
    const manager = new DesktopWindowManager({
      onRecoveryExhausted,
      createWindow() {
        const window = new FakeWindow()
        window.webContents.reload.mockImplementation(() => {
          throw new Error('fixture reload failure')
        })
        windows.push(window)
        return {
          load: vi.fn().mockResolvedValue(undefined),
          window: window as unknown as BrowserWindow,
        }
      },
    })
    await manager.load()
    windows[0]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await vi.waitFor(() => expect(onRecoveryExhausted).toHaveBeenCalledOnce())
    expect(windows).toHaveLength(1)
    expect(manager.recoveryExhausted).toBe(true)
    manager.dispose()
  })
})
