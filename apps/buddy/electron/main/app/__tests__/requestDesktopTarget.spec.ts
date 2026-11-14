import type { BrowserWindow, IpcMain } from 'electron'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC_CHANNELS } from '../../../shared/desktopApi'
import { requestDesktopTarget } from '../requestDesktopTarget'
import { createStartupFixture } from './startupFixture'

vi.mock('electron', () => ({ ipcMain: {} }))
afterEach(() => vi.useRealTimers())

function fixture() {
  const { startup, complete, connect } = createStartupFixture()
  complete('desktop')
  connect('runtime-1')
  complete('renderer')
  const ipc = new EventEmitter()
  let request!: { requestId: string }
  const webContents = { mainFrame: {}, isDestroyed: () => false, send: (_channel: string, input: typeof request) => {
    request = input
  } }
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents })
  const open = (options = {}) => requestDesktopTarget(window as unknown as BrowserWindow, startup, { kind: 'tasks' }, ipc as unknown as IpcMain, options)
  const ack = (sender = webContents, senderFrame = webContents.mainFrame, requestId = request.requestId) => ipc.emit(DESKTOP_IPC_CHANNELS.appOpenTargetAck, { sender, senderFrame }, { requestId, opened: true })
  return { open, ack, window, webContents, ipc }
}

it('acknowledges only the requested target from the current main frame', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const opening = f.open()
  let settled = false
  void opening.then(() => settled = true)
  await vi.advanceTimersByTimeAsync(0)
  f.ack({ ...f.webContents })
  f.ack(f.webContents, {})
  f.ack(f.webContents, f.webContents.mainFrame, '00000000-0000-4000-8000-000000000000')
  await vi.advanceTimersByTimeAsync(100)
  expect(settled).toBe(false)
  f.ack()
  await expect(opening).resolves.toBe(true)
  expect(f.ipc.listenerCount(DESKTOP_IPC_CHANNELS.appOpenTargetAck)).toBe(0)
})

it.each(['timeout', 'closed'])('does not report a visible target after %s', async (reason) => {
  vi.useFakeTimers()
  const f = fixture()
  const opening = f.open()
  await vi.advanceTimersByTimeAsync(0)
  if (reason === 'closed')
    f.window.emit('closed')
  else
    await vi.advanceTimersByTimeAsync(20000)
  await expect(opening).resolves.toBe(false)
  expect(f.ipc.listenerCount(DESKTOP_IPC_CHANNELS.appOpenTargetAck)).toBe(0)
})

it('does not accept a target acknowledgement after locking or cancellation', async () => {
  vi.useFakeTimers()
  const f = fixture()
  let available = true
  const opening = f.open({ available: () => available })
  await vi.advanceTimersByTimeAsync(0)
  available = false
  f.ack()
  await expect(opening).resolves.toBe(false)
  const controller = new AbortController()
  const cancelled = f.open({ signal: controller.signal })
  await vi.advanceTimersByTimeAsync(0)
  controller.abort()
  await expect(cancelled).resolves.toBe(false)
  expect(f.ipc.listenerCount(DESKTOP_IPC_CHANNELS.appOpenTargetAck)).toBe(0)
})
