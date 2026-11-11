import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { ExtensionViewSession } from '../../../../shared/extensions/extensionApi'
import { deferred } from '@buddy-tests/deferred'
import { beforeEach, expect, it, vi } from 'vitest'
import { assertTaskCleanupConfirmationSender, createExtensionTaskCleanupConfirmation } from '../ExtensionTaskCleanup'

const showMessageBox = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ dialog: { showMessageBox } }))
beforeEach(() => showMessageBox.mockReset())
const session: ExtensionViewSession = { id: 'view', extensionId: 'test.cleanup', generation: 'generation', token: 'token', url: 'lexora-extension://token/__view.html' }
const target = { conversationId: 'legacy-task', expectedRevision: 4 }
function fixture() {
  const state = { visible: true, focused: true, minimized: false, destroyed: false, frame: session.url }
  const owner = { isDestroyed: () => state.destroyed, isVisible: () => state.visible, isMinimized: () => state.minimized, isFocused: () => state.focused, webContents: { isDestroyed: () => state.destroyed, get focusedFrame() {
    return { url: state.frame }
  } } }
  return { state, confirm: createExtensionTaskCleanupConfirmation(() => owner as unknown as BrowserWindow) }
}

it('accepts only the current focused main window frame for host confirmation', () => {
  const mainFrame = { url: 'lexora://desktop' }
  const pluginFrame = { url: session.url }
  const state = { focusedFrame: mainFrame, visible: true, focused: true, minimized: false, destroyed: false }
  const owner = { isDestroyed: () => state.destroyed, isVisible: () => state.visible, isMinimized: () => state.minimized, isFocused: () => state.focused, webContents: { isDestroyed: () => false, mainFrame, get focusedFrame() {
    return state.focusedFrame
  } } }
  const confirm = (sender: unknown = owner.webContents, senderFrame: unknown = mainFrame) => assertTaskCleanupConfirmationSender({ sender, senderFrame } as IpcMainInvokeEvent, owner as unknown as BrowserWindow)
  expect(() => confirm()).not.toThrow()
  expect(() => confirm(owner.webContents, pluginFrame)).toThrow('EXTENSION_TASK_CLEANUP_UNAVAILABLE')
  expect(() => confirm({}, mainFrame)).toThrow('EXTENSION_TASK_CLEANUP_UNAVAILABLE')
  expect(() => confirm(owner.webContents, { ...mainFrame })).toThrow('EXTENSION_TASK_CLEANUP_UNAVAILABLE')
  state.focusedFrame = pluginFrame
  expect(() => confirm()).toThrow('EXTENSION_TASK_CLEANUP_UNAVAILABLE')
  state.focusedFrame = mainFrame
  for (const key of ['visible', 'focused', 'minimized', 'destroyed'] as const) {
    state[key] = !state[key]
    expect(() => confirm()).toThrow('EXTENSION_TASK_CLEANUP_UNAVAILABLE')
    state[key] = !state[key]
  }
})

it.each(['visible', 'focused', 'minimized', 'destroyed', 'frame'] as const)('rejects untrusted native presentation: %s', async (key) => {
  const f = fixture()
  if (key === 'frame')
    f.state.frame = 'lexora-extension://another/__view.html'
  else f.state[key] = !f.state[key]
  await expect(f.confirm(session, target, () => {})).rejects.toThrow('EXTENSION_TASK_CLEANUP_UNAVAILABLE')
})

it('requires affirmative native confirmation with a safe default and exact target', async () => {
  const f = fixture()
  showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
  expect(await f.confirm(session, target, () => {})).toBe(false)
  expect(await f.confirm(session, target, () => {})).toBe(true)
  const options = showMessageBox.mock.calls[0]![1]
  expect(options).toMatchObject({ defaultId: 0, cancelId: 0, buttons: ['取消', '删除'] })
  expect(options.detail).toContain(target.conversationId)
  expect(options.detail).toContain('无法撤销')
})

it('rejects concurrent dialogs and a late answer after view revocation', async () => {
  const f = fixture()
  const answer = deferred<{ response: number }>()
  let current = true
  showMessageBox.mockReturnValue(answer.promise)
  const pending = f.confirm(session, target, () => {
    if (!current)
      throw new Error('EXPIRED')
  })
  const rejected = expect(pending).rejects.toThrow('EXPIRED')
  await expect(f.confirm(session, target, () => {})).rejects.toThrow('EXTENSION_TASK_CLEANUP_UNAVAILABLE')
  current = false
  answer.resolve({ response: 1 })
  await rejected
})
