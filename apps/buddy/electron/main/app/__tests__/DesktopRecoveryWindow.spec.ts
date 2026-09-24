import { describe, expect, it, vi } from 'vitest'
import { showRecoveryWindow } from '../DesktopRecoveryWindow'
import { describeDesktopStartupFailure } from '../desktopStartupFailure'

const native = vi.hoisted(() => ({ current: undefined as { navigate: () => void, close: () => void, rejectScript: (error: Error) => void } | undefined }))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    destroyed = false
    rejectScript: (error: Error) => void = () => {}
    webContents = Object.assign(new EventEmitter(), {
      executeJavaScript: () => new Promise<void>((_resolve, reject) => { this.rejectScript = reject }),
      setWindowOpenHandler: () => {},
    })

    constructor() {
      super()
      native.current = {
        navigate: () => this.webContents.emit('will-navigate', { preventDefault() {} }, 'https://lexora-recovery.invalid/retry'),
        close: () => this.destroy(),
        rejectScript: error => this.rejectScript(error),
      }
    }

    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    show() {}
    focus() {}
    loadURL() { return Promise.resolve() }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
  }
  return {
    app: new EventEmitter(),
    BrowserWindow: Window,
    session: { fromPartition: () => Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } }) },
  }
})

describe('recovery window lifecycle', () => {
  it('resolves a user close during action rendering without falling back to another dialog or dispatching a restart', async () => {
    const actions: string[] = []
    const completion = showRecoveryWindow(describeDesktopStartupFailure(new Error('fixture'), 'en-US'), 'Checking', async (action) => {
      actions.push(action)
      return { done: true }
    })
    native.current!.navigate()
    native.current!.close()
    native.current!.rejectScript(new Error('WebContents was destroyed'))
    await expect(completion).resolves.toBeUndefined()
    expect(actions).toEqual([])
  })
})
