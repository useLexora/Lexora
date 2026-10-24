import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_PREPARATION_TIMEOUT_MS } from '../../../shared/lifecycle/closePreparation'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { confirmDraftFlushBeforeQuit, requestRendererDraftFlush } from '../rendererDraftLifecycle'

afterEach(() => vi.useRealTimers())

function fixture() {
  type AckListener = (event: IpcMainEvent, input: unknown) => void
  const listeners = new Map<string, AckListener>()
  const ipc = {
    off: (channel: string) => listeners.delete(channel),
    on: (channel: string, listener: AckListener) => listeners.set(channel, listener),
  } as unknown as Pick<IpcMain, 'off' | 'on'>
  const webContents = { isDestroyed: () => false, send: vi.fn() }
  const window = { isDestroyed: () => false, webContents } as unknown as BrowserWindow
  return { ipc, listeners, webContents, window }
}

describe('renderer Draft lifecycle', () => {
  it.each([
    { decisions: ['retry', 'discard'] as const, expected: true, flushes: 2 },
    { decisions: ['cancel'] as const, expected: false, flushes: 1 },
  ])('handles an explicit $decisions save-failure decision', async ({ decisions, expected, flushes }) => {
    const flush = vi.fn(async () => false)
    const pending = [...decisions]

    await expect(confirmDraftFlushBeforeQuit(flush, async () => pending.shift()!))
      .resolves
      .toBe(expected)
    expect(flush).toHaveBeenCalledTimes(flushes)
  })

  it('continues without a prompt after a confirmed flush', async () => {
    const resolveFailure = vi.fn()
    await expect(confirmDraftFlushBeforeQuit(async () => true, resolveFailure)).resolves.toBe(true)
    expect(resolveFailure).not.toHaveBeenCalled()
  })

  it('waits beyond document close preparation and accepts only its own renderer acknowledgement', async () => {
    vi.useFakeTimers()
    const { ipc, listeners, webContents, window } = fixture()

    const flushing = requestRendererDraftFlush(window, ipc)
    const [, input] = webContents.send.mock.calls[0]!
    let settled = false
    void flushing.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(CLOSE_PREPARATION_TIMEOUT_MS + 1)
    expect(settled).toBe(false)
    const acknowledge = listeners.get(DESKTOP_IPC_CHANNELS.appPrepareQuitAck)!
    acknowledge({ sender: {} } as IpcMainEvent, { ...input, saved: true })
    acknowledge({ sender: webContents } as unknown as IpcMainEvent, { requestId: 'wrong', saved: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    acknowledge({ sender: webContents } as unknown as IpcMainEvent, { ...input, saved: true })

    await expect(flushing).resolves.toBe(true)
    expect(listeners.size).toBe(0)
  })

  it('fails closed when the renderer does not acknowledge in time', async () => {
    vi.useFakeTimers()
    const { ipc, listeners, webContents, window } = fixture()

    const flushing = requestRendererDraftFlush(window, ipc, 100)
    await vi.advanceTimersByTimeAsync(100)

    await expect(flushing).resolves.toBe(false)
    expect(listeners.size).toBe(0)
    const [, request] = webContents.send.mock.calls[0]!
    expect(webContents.send.mock.calls[1]).toEqual([DESKTOP_IPC_CHANNELS.appCancelQuitPreparation, request])
  })
})
