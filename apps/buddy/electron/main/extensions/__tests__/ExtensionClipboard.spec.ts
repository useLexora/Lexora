import type { BrowserWindow } from 'electron'
import type { ExtensionViewSession } from '../../../../shared/extensions/extensionApi'
import { deferred } from '@buddy-tests/deferred'
import { beforeEach, expect, it, vi } from 'vitest'
import { EXTENSION_CLIPBOARD_BYTES_LIMIT } from '../../../../shared/extensions/extensionClipboard'
import { createExtensionClipboard } from '../ExtensionClipboard'

const native = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('electron', () => ({ clipboard: native, ClipboardItem: class {
  readonly values: Record<string, string>
  constructor(values: Record<string, string>) { this.values = values }
} }))
beforeEach(() => {
  native.read.mockReset()
  native.write.mockReset()
})
const session: ExtensionViewSession = { id: 'view', extensionId: 'test.clipboard', generation: 'generation', token: 'token', url: 'lexora-extension://token/__view.html' }
function fixture() {
  const state = { visible: true, minimized: false, focused: true, destroyed: false, frame: session.url }
  const owner = { isDestroyed: () => state.destroyed, isVisible: () => state.visible, isMinimized: () => state.minimized, isFocused: () => state.focused, webContents: { isDestroyed: () => state.destroyed, get focusedFrame() {
    return state.frame ? { url: state.frame } : null
  } } }
  return { state, api: createExtensionClipboard(() => owner as unknown as BrowserWindow) }
}
function valid() {}
it.each(['visible', 'minimized', 'focused', 'destroyed', 'frame'] as const)('denies clipboard access when the trusted window/frame is unavailable: %s', async (key) => {
  const { state, api } = fixture()
  if (key === 'frame')
    state.frame = 'lexora-extension://other/__view.html'
  else state[key] = !state[key]
  await expect(api.read(session, valid)).rejects.toThrow('EXTENSION_CLIPBOARD_UNAVAILABLE')
  await expect(api.write(session, { text: 'private' }, valid)).rejects.toThrow('EXTENSION_CLIPBOARD_UNAVAILABLE')
  expect(native.read).not.toHaveBeenCalled()
  expect(native.write).not.toHaveBeenCalled()
})
it('reads only bounded text/HTML from one clipboard snapshot and atomically writes both formats', async () => {
  const { api } = fixture()
  const html = '<table data-copy-id="table-1"><tr><td>中文</td></tr></table>'
  native.read.mockResolvedValue([{ types: ['text/plain', 'text/html', 'image/png'], getType: async (type: string) => new Blob([type === 'text/html' ? html : '中文']) }])
  expect(await api.read(session, valid)).toEqual({ text: '中文', html })
  await api.write(session, { text: '中文', html }, valid)
  expect(native.write.mock.calls).toEqual([[[{ values: { 'text/plain': '中文', 'text/html': html } }]]])
  native.read.mockResolvedValue([{ types: ['text/plain'], getType: async () => new Blob(['x'.repeat(EXTENSION_CLIPBOARD_BYTES_LIMIT + 1)]) }])
  await expect(api.read(session, valid)).rejects.toThrow('EXTENSION_CLIPBOARD_TOO_LARGE')
})
it.each(['focus', 'lifecycle'])('does not deliver clipboard content after %s changes while reading', async (change) => {
  const { state, api } = fixture()
  const pending = deferred<Blob>()
  let current = true
  native.read.mockResolvedValue([{ types: ['text/plain'], getType: () => pending.promise }])
  const result = api.read(session, () => {
    if (!current)
      throw new Error('EXPIRED')
  })
  await Promise.resolve()
  if (change === 'focus')
    state.focused = false
  else current = false
  pending.resolve(new Blob(['private']))
  await expect(result).rejects.toThrow(change === 'focus' ? 'EXTENSION_CLIPBOARD_UNAVAILABLE' : 'EXPIRED')
})
it('rechecks lifecycle immediately before writing', async () => {
  const { api } = fixture()
  await expect(api.write(session, { text: '' }, () => {
    throw new Error('EXPIRED')
  })).rejects.toThrow('EXPIRED')
  expect(native.write).not.toHaveBeenCalled()
})
