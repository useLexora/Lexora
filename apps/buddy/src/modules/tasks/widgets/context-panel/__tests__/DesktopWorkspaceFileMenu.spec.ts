// @vitest-environment jsdom
import type { SpaceFileMutationResult } from '@buddy-shared/spaces/spaceFileApi'
import type { TreeOption } from 'naive-ui'
import type { TaskFilesContextTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopContextFileTree from '@/shared/ui/files/DesktopContextFileTree.vue'
import DesktopWorkspaceFileMenu from '../DesktopWorkspaceFileMenu.vue'

const messages = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('naive-ui', async (original) => {
  const actual = await original<typeof import('naive-ui')>()
  const { defineComponent, h, nextTick, watch } = await import('vue')
  return { ...actual, useMessage: () => messages, NModal: defineComponent({
    props: ['show', 'title'],
    emits: ['after-enter', 'after-leave', 'update:show'],
    setup(props, { slots, emit }) {
      watch(() => props.show, async (value) => {
        await nextTick()
        emit(value ? 'after-enter' : 'after-leave')
      })
      return () => props.show ? h('section', { 'class': 'test-modal', 'role': 'dialog', 'aria-label': props.title }, slots.default?.()) : null
    },
  }) }
})
const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
async function flush() {
  await Promise.resolve()
  await nextTick()
  await nextTick()
  await nextTick()
}
function fixture(contextMenu = true, writable = true) {
  const tab = shallowRef<TaskFilesContextTab | null>({ id: 'files:one', scope: 'workspace', kind: 'files', rootName: 'fixture', target: { spaceId: 'space', directoryId: 'directory', revision: 1, path: '' } })
  const control = shallowRef<InstanceType<typeof DesktopWorkspaceFileMenu> | null>(null)
  const root = document.createElement('div')
  document.body.append(root)
  const mutateEntry = vi.fn().mockResolvedValue({ status: 'completed', path: 'new.md', kind: 'file' })
  const openEntry = vi.fn().mockResolvedValue(true)
  const locateEntry = vi.fn().mockResolvedValue({ path: 'C:/workspace/src/note.md', kind: 'file' })
  const revealFile = vi.fn().mockResolvedValue(undefined)
  const closeEntries = vi.fn().mockResolvedValue(true)
  const writeClipboardText = vi.fn().mockResolvedValue(undefined)
  const refresh = vi.fn().mockResolvedValue(true)
  const expand = vi.fn()
  const choose = vi.fn()
  const treeSelect = vi.fn()
  const files = { mutateEntry, openEntry, locateEntry, revealFile, closeEntries, listDirectory: vi.fn(), readFile: vi.fn() }
  const nodes: TreeOption[] = [{ key: 'src/note.md', label: 'note.md', kind: 'file', isLeaf: true, writable }, { key: 'src', label: 'src', kind: 'directory', children: [], writable }]
  const app = createApp({ render: () => h('div', [
    h(DesktopContextFileTree, { language: 'en-US', nodes, selectedKey: null, expandedKeys: [], contextMenu, onMenu: value => control.value?.show(value), onSelect: treeSelect }),
    h(DesktopWorkspaceFileMenu, { ref: control, tab: tab.value, files, language: 'en-US', writeClipboardText, refresh, expand, onChoose: choose }),
  ]) })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  function row(label = 'note.md') {
    return [...root.querySelectorAll<HTMLElement>('.n-tree-node')].find(node => node.querySelector('.n-tree-node-content__text')?.textContent === label)!
  }
  async function show(label?: string) {
    const element = label === '' ? root.querySelector<HTMLElement>('[data-testid="context-file-tree"]')! : row(label)
    element.focus()
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 }))
    await flush()
  }
  function options() {
    return [...document.querySelectorAll<HTMLElement>('.n-dropdown-option-body')]
  }
  async function select(label: string) {
    const option = options().find(option => option.textContent?.trim() === label)
    expect(option, label).toBeTruthy()
    option!.click()
    await flush()
  }
  function button(label: string) {
    return [...root.querySelectorAll<HTMLButtonElement>('.test-modal button')].find(button => button.textContent?.trim() === label)!
  }
  async function setName(value: string) {
    const input = root.querySelector<HTMLInputElement>('input')!
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
  }
  async function submit() {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
  }
  return { root, tab, row, show, select, options, button, setName, submit, mutateEntry, openEntry, refresh, expand, choose, treeSelect, revealFile, locateEntry, closeEntries, writeClipboardText }
}

describe('workspace file menus', () => {
  it('uses the actual right-click target and keeps root/readonly menus non-destructive', async () => {
    const f = fixture(true, false)
    await f.show()
    expect(f.treeSelect).not.toHaveBeenCalled()
    expect(f.options().map(option => option.textContent?.trim())).not.toContain('Rename')
    await f.select('Copy relative path')
    expect(f.writeClipboardText).toHaveBeenCalledWith('src/note.md')
    await f.show()
    await f.select('Copy full path')
    expect(f.locateEntry).toHaveBeenCalledWith({ ...f.tab.value!.target, path: 'src/note.md' })
    expect(f.writeClipboardText).toHaveBeenLastCalledWith('C:/workspace/src/note.md')
    await f.show()
    await f.select('Show in system file manager')
    expect(f.revealFile).toHaveBeenCalledWith({ ...f.tab.value!.target, path: 'src/note.md' })
    await f.show('')
    expect(f.options().map(option => option.textContent?.trim())).toContain('New file')
    expect(f.options().map(option => option.textContent?.trim())).not.toContain('Rename')
    expect(f.options().map(option => option.textContent?.trim())).not.toContain('Move to Recycle Bin')
    await f.select('Open in system file manager')
    expect(f.revealFile).toHaveBeenLastCalledWith(f.tab.value!.target)
  })
  it('preserves read-only shared trees when the optional menu capability is absent', async () => {
    const f = fixture(false)
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    f.row().dispatchEvent(event)
    await flush()
    expect(event.defaultPrevented).toBe(false)
    expect(f.options()).toEqual([])
    expect(f.mutateEntry).not.toHaveBeenCalled()
  })
  it('supports Shift+F10, real dropdown direction keys, Enter, Escape and focus return', async () => {
    const f = fixture()
    const row = f.row()
    row.focus()
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    await flush()
    expect(f.options().length).toBeGreaterThan(0)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flush()
    expect(f.choose).toHaveBeenCalledWith('files:one', 'src/note.md', true)
    await f.show()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
    expect(document.activeElement).toBe(row)
    expect(f.mutateEntry).not.toHaveBeenCalled()
  })
  it('validates names, suppresses repeated submission and opens a created file through the edit capability', async () => {
    const f = fixture()
    await f.show('')
    await f.select('New file')
    const input = f.root.querySelector<HTMLInputElement>('input')!
    expect(f.root.querySelector('label')?.htmlFor).toBe(input.id)
    expect(document.activeElement).toBe(input)
    await f.setName('../wrong')
    await f.submit()
    expect(f.mutateEntry).not.toHaveBeenCalled()
    expect(f.root.querySelector('[role="alert"]')?.textContent).toContain('Invalid name')
    expect(input.getAttribute('aria-describedby')).toBe(f.root.querySelector('[role="alert"]')?.id)
    await f.setName('new.md')
    const pending = deferred<SpaceFileMutationResult>()
    f.mutateEntry.mockReturnValueOnce(pending.promise)
    await f.submit()
    await f.submit()
    expect(f.mutateEntry).toHaveBeenCalledOnce()
    expect(f.mutateEntry).toHaveBeenCalledWith({ ...f.tab.value!.target, operation: 'create-file', name: 'new.md' })
    pending.resolve({ status: 'completed', path: 'new.md', kind: 'file' })
    await flush()
    expect(f.refresh).toHaveBeenCalledOnce()
    expect(f.openEntry).toHaveBeenCalledWith({ ...f.tab.value!.target, path: 'new.md' }, 'files:one')
    expect(f.choose).toHaveBeenCalledWith('files:one', 'new.md', true)
  })
  it('creates a folder inside the captured directory without opening an editor', async () => {
    const f = fixture()
    await f.show('src')
    await f.select('New folder')
    await f.setName('child')
    f.mutateEntry.mockResolvedValueOnce({ status: 'completed', path: 'src/child', kind: 'directory' })
    await f.submit()
    expect(f.mutateEntry).toHaveBeenCalledWith({ ...f.tab.value!.target, path: 'src', operation: 'create-directory', name: 'child' })
    expect(f.expand).toHaveBeenCalledWith('files:one', 'src')
    expect(f.choose).toHaveBeenCalledWith('files:one', 'src/child', false)
    expect(f.openEntry).not.toHaveBeenCalled()
  })
  it('selects the basename and performs no write for an unchanged name', async () => {
    const f = fixture()
    await f.show()
    await f.select('Rename')
    const input = f.root.querySelector<HTMLInputElement>('input')!
    expect(input.value).toBe('note.md')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(4)
    await f.submit()
    expect(f.mutateEntry).not.toHaveBeenCalled()
    expect(f.root.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(f.row())
  })
  it('defaults deletion to Cancel and never mutates on cancellation', async () => {
    const f = fixture()
    await f.show('src')
    await f.select('Move to Recycle Bin')
    expect(f.root.querySelector('[role="dialog"]')?.textContent).toContain('all its contents')
    expect(document.activeElement).toBe(f.button('Cancel'))
    f.button('Cancel').click()
    await flush()
    expect(f.mutateEntry).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(f.row('src'))
  })
  it('requires an explicit close action and retry for opened resources', async () => {
    const f = fixture()
    await f.show()
    await f.select('Rename')
    await f.setName('renamed.md')
    f.mutateEntry.mockResolvedValueOnce({ status: 'failed', reason: 'open-resource' })
    await f.submit()
    expect(f.closeEntries).not.toHaveBeenCalled()
    f.button('Close related files').click()
    await flush()
    expect(f.closeEntries).toHaveBeenCalledWith({ ...f.tab.value!.target, path: 'src/note.md' })
    expect(f.mutateEntry).toHaveBeenCalledOnce()
    expect(f.root.querySelector('[role="alert"]')).toBeNull()
    f.mutateEntry.mockResolvedValueOnce({ status: 'completed', path: 'src/renamed.md', kind: 'file' })
    await f.submit()
    expect(f.choose).toHaveBeenCalledWith('files:one', 'src/renamed.md', false)
    expect(f.openEntry).not.toHaveBeenCalled()
  })
  it('does not retry an uncertain destructive result', async () => {
    const f = fixture()
    await f.show()
    await f.select('Move to Recycle Bin')
    f.mutateEntry.mockResolvedValueOnce({ status: 'failed', reason: 'result-unknown' })
    f.button('Move to Recycle Bin').click()
    await flush()
    expect(f.refresh).toHaveBeenCalledOnce()
    expect(f.button('Move to Recycle Bin').disabled).toBe(true)
    expect(f.root.querySelector('[role="alert"]')?.textContent).toContain('uncertain')
    expect(f.choose).not.toHaveBeenCalled()
  })
  it('keeps a submitted result scoped to its original tab and discards late navigation', async () => {
    const f = fixture()
    await f.show('')
    await f.select('New file')
    const original = f.tab.value!
    const pending = deferred<SpaceFileMutationResult>()
    f.mutateEntry.mockReturnValueOnce(pending.promise)
    await f.submit()
    f.tab.value = { ...original, id: 'files:two', target: { ...original.target, directoryId: 'other' } }
    await flush()
    expect(f.root.querySelector('[role="dialog"]')).toBeNull()
    pending.resolve({ status: 'completed', path: 'new.md', kind: 'file' })
    await flush()
    expect(f.refresh).toHaveBeenCalledWith(original)
    expect(f.choose).not.toHaveBeenCalled()
    expect(f.openEntry).not.toHaveBeenCalled()
    expect(messages.warning).not.toHaveBeenCalled()
  })
  it('reports a completed disk operation separately from a failed refresh', async () => {
    const f = fixture()
    await f.show('')
    await f.select('New file')
    f.refresh.mockResolvedValueOnce(false)
    await f.submit()
    expect(messages.warning).toHaveBeenCalledWith(expect.stringContaining('disk operation completed'))
    expect(f.mutateEntry).toHaveBeenCalledOnce()
    expect(f.openEntry).not.toHaveBeenCalled()
    expect(f.root.querySelector('[role="dialog"]')).toBeNull()
  })
})
