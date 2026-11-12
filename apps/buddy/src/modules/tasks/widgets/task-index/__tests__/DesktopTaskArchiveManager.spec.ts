// @vitest-environment jsdom
import type { ConversationArchiveItem } from '@buddy-shared/conversation/conversationArchiveApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { TaskArchiveActions } from '../../../contracts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopTaskArchiveManager from '../DesktopTaskArchiveManager.vue'

const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }))
})
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  document.body.innerHTML = ''
})
function item(id = 'task', overrides: Partial<ConversationArchiveItem> = {}): ConversationArchiveItem {
  return { id, title: `历史任务 ${id}`, spaceId: null, archivedAt: '2026-11-01T00:00:00Z', deletedAt: null, updatedAt: '2026-11-01T00:00:00Z', metadataRevision: 3, deletionStatus: null, errorCode: null, ...overrides }
}
function space(id: string, name: string, revokedAt: string | null = null): LocalSpace {
  return { id, name, revokedAt, icon: 'folder', iconColor: 'default', activeRunCount: 0, additionalDirectories: [], primaryDirectory: null, memoryScope: 'space_only', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
}
async function mount(items = [item()], language: 'zh-CN' | 'en-US' = 'zh-CN', spaces: readonly LocalSpace[] = []) {
  const ready = shallowRef(true)
  const list = vi.fn<TaskArchiveActions['list']>().mockResolvedValue({ items, nextCursor: null })
  const remove = vi.fn<TaskArchiveActions['delete']>().mockResolvedValue(true)
  const restore = vi.fn<TaskArchiveActions['restore']>().mockResolvedValue(true)
  const onView = vi.fn()
  const listeners = new Set<() => void>()
  const actions: TaskArchiveActions = {
    ready,
    onChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: vi.fn(),
    archive: vi.fn(),
    restore,
    delete: remove,
    list,
    getPolicy: async () => ({ days: 0 }),
    setPolicy: async days => ({ days }),
  }
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ render: () => h(DesktopTaskArchiveManager, { actions, spaces, language, onView }) })
  app.mount(root)
  cleanups.push(() => app.unmount())
  await nextTick()
  await nextTick()
  return { root, ready, list, remove, restore, onView, notify: () => listeners.forEach(listener => listener()) }
}
function button(label: string, root: ParentNode = document) {
  const match = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => (button.getAttribute('aria-label') || button.textContent?.trim()) === label)
  expect(match, `button: ${label}`).toBeDefined()
  return match!
}

async function openSpaceCleanup(name: string, root: ParentNode) {
  button(`空间操作：${name}`, root).click()
  await vi.waitFor(() => expect(document.querySelector('.n-dropdown-option')).not.toBeNull())
  const option = [...document.querySelectorAll<HTMLElement>('.n-dropdown-option')].find(option => option.textContent?.includes('清理归档任务'))
  expect(option).toBeDefined()
  option!.querySelector<HTMLElement>('.n-dropdown-option-body')!.click()
  await vi.waitFor(() => expect(document.querySelector('[data-testid="task-archive-delete-confirm"]')).not.toBeNull())
}

it.each(['zh-CN', 'en-US'] as const)('renders inline with localized dates and keeps viewing separate from restoring in %s', async (language) => {
  const f = await mount([item()], language)
  expect(f.root.querySelector('[data-testid="task-archive-manager"]')?.tagName).toBe('SECTION')
  expect(f.root.querySelector('time')?.textContent).toBe(new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date('2026-11-01T00:00:00Z')))
  button('历史任务 task', f.root).click()
  expect(f.onView.mock.calls).toEqual([['task']])
  expect(f.restore).not.toHaveBeenCalled()
  expect(f.root.querySelector('[data-archive-id="task"]')).not.toBeNull()
  button(language === 'zh-CN' ? '取消归档' : 'Unarchive', f.root).click()
  await vi.waitFor(() => expect(f.restore.mock.calls).toEqual([['task', 3]]))
})

it('reveals failure details on demand and permits retry without allowing pending deletion', async () => {
  const f = await mount()
  f.list.mockResolvedValue({ items: [item('failed', { deletionStatus: 'failed', errorCode: 'FILE_ACCESS_DENIED' }), item('pending', { deletionStatus: 'pending' })], nextCursor: null })
  f.notify()
  await vi.waitFor(() => expect(f.root.textContent).toContain('清理失败'))
  button('清理失败', f.root).click()
  await vi.waitFor(() => expect(document.body.textContent).toContain('FILE_ACCESS_DENIED'))
  const pending = f.root.querySelector('[data-archive-id="pending"]')!
  expect(button('删除', pending).disabled).toBe(true)
  expect(pending.textContent).toContain('删除中')
  expect(f.root.querySelector('[data-archive-id="failed"]')?.textContent).toContain('清理失败')
  button('删除', f.root.querySelector('[data-archive-id="failed"]')!).click()
  await nextTick()
  const confirmation = document.querySelector('[data-testid="task-archive-delete-confirm"]')!
  expect(confirmation.textContent).toContain('历史任务 failed')
  expect(confirmation.textContent).not.toContain('历史任务 pending')
  button('删除', confirmation).click()
  await vi.waitFor(() => expect(f.remove.mock.calls).toEqual([['failed', 3]]))
})

it('keeps confirmed IDs and revisions fixed across refresh and reports each deletion outcome', async () => {
  const f = await mount([item('one'), item('two', { metadataRevision: 7 })])
  await openSpaceCleanup('未绑定空间', f.root)
  await nextTick()
  const confirmation = document.querySelector('[data-testid="task-archive-delete-confirm"]')!
  expect(confirmation.textContent).toContain('不可恢复')
  expect(f.remove).not.toHaveBeenCalled()
  f.list.mockResolvedValue({ items: [item('other', { metadataRevision: 99 })], nextCursor: null })
  f.notify()
  await vi.waitFor(() => expect(f.root.textContent).toContain('历史任务 other'))
  expect(confirmation.textContent).toContain('历史任务 one')
  expect(confirmation.textContent).toContain('历史任务 two')
  expect(confirmation.textContent).not.toContain('历史任务 other')
  f.remove.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  button('删除', confirmation).click()
  await vi.waitFor(() => expect(f.root.querySelectorAll('[data-delete-result]')).toHaveLength(1))
  expect(f.remove.mock.calls).toEqual([['one', 3], ['two', 7]])
  expect(f.root.querySelector('[data-delete-result="failed"]')?.textContent).toContain('操作未完成')
  expect(f.root.querySelector('[data-delete-result="failed"]')?.textContent).toContain('历史任务 two')
})

it('groups tasks by their real space without mislabelling revoked or unresolved spaces as unbound', async () => {
  const f = await mount([
    item('active-space', { spaceId: 'space-a' }),
    item('removed-space', { spaceId: 'space-old' }),
    item('unknown-space', { spaceId: 'space-unknown' }),
    item('unbound'),
  ], 'zh-CN', [space('space-a', '设计空间'), space('space-old', '旧空间', '2026-11-01T00:00:00Z')])
  expect(f.root.querySelector('[data-archive-space="space-a"]')?.textContent).toContain('设计空间')
  const oldSpace = f.root.querySelector('[data-archive-space="space-old"]')!
  expect(oldSpace.querySelector('header')?.textContent?.trim()).toBe('旧空间')
  expect(oldSpace.querySelector('[data-archive-id="removed-space"]')).not.toBeNull()
  expect(button('空间操作：旧空间', oldSpace).disabled).toBe(false)
  expect(f.root.querySelector('[data-archive-space="space-unknown"]')?.textContent).toContain('空间信息暂不可用')
  expect(f.root.querySelector('[data-archive-space=""]')?.textContent).toContain('未绑定空间')
})

it('renders only populated groups and removes a group when its last archived task disappears', async () => {
  const first = item('first', { spaceId: 'space-a' })
  const remaining = item('remaining', { spaceId: 'space-b' })
  const f = await mount([first, remaining], 'zh-CN', [
    space('space-a', '设计空间'),
    space('space-b', '历史空间', '2026-11-01T00:00:00Z'),
    space('space-empty', '没有归档的空间'),
  ])
  const groupIds = () => [...f.root.querySelectorAll('[data-archive-space]')].map(group => group.getAttribute('data-archive-space')).sort()
  expect(groupIds()).toEqual(['space-a', 'space-b'])
  f.list.mockResolvedValue({ items: [remaining], nextCursor: null })
  f.notify()
  await vi.waitFor(() => expect(groupIds()).toEqual(['space-b']))
  expect(f.root.querySelector('[data-archive-space="space-b"] [data-archive-id="remaining"]')).not.toBeNull()
  f.list.mockResolvedValue({ items: [], nextCursor: null })
  f.notify()
  await vi.waitFor(() => expect(f.root.textContent).toContain('没有匹配的任务'))
  expect(groupIds()).toEqual([])
})

it('previews every archive page in a space and only submits the confirmed immutable targets', async () => {
  const first = item('visible', { spaceId: 'space-a' })
  const second = item('beyond-first-page', { spaceId: 'space-a', metadataRevision: 8 })
  const f = await mount([first], 'zh-CN', [space('space-a', '设计空间')])
  f.list.mockResolvedValueOnce({ items: [first], nextCursor: 'next' }).mockResolvedValueOnce({ items: [second], nextCursor: null })
  await openSpaceCleanup('设计空间', f.root)
  await vi.waitFor(() => expect(document.querySelector('[data-testid="task-archive-delete-confirm"]')?.textContent).toContain('历史任务 beyond-first-page'))
  const confirmation = document.querySelector('[data-testid="task-archive-delete-confirm"]')!
  expect(confirmation.textContent).toContain('已归档的 2 个任务')
  expect(confirmation.textContent).toContain('不包含活动任务')
  expect(f.remove).not.toHaveBeenCalled()
  expect(f.list.mock.calls.slice(-2)).toEqual([[{ kind: 'managed', spaceId: 'space-a', limit: 100 }], [{ kind: 'managed', spaceId: 'space-a', limit: 100, cursor: 'next' }]])
  Object.assign(first, { metadataRevision: 99 })
  button('删除', confirmation).click()
  await vi.waitFor(() => expect(f.remove.mock.calls).toEqual([['visible', 3], ['beyond-first-page', 8]]))
})

it('passes search to the service and appends cursor pages without claiming a global count', async () => {
  const f = await mount()
  f.list.mockResolvedValueOnce({ items: [item('matching')], nextCursor: 'next' })
  const input = f.root.querySelector('input')!
  input.value = 'matching'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => expect(f.root.querySelector('[data-archive-id="matching"]')).not.toBeNull())
  expect(f.list).toHaveBeenLastCalledWith({ kind: 'managed', query: 'matching', limit: 50 })
  f.list.mockResolvedValueOnce({ items: [item('next')], nextCursor: null })
  button('加载更多', f.root).click()
  await vi.waitFor(() => expect(f.root.querySelectorAll('[data-archive-id]')).toHaveLength(2))
  expect(f.list).toHaveBeenLastCalledWith({ kind: 'managed', query: 'matching', limit: 50, cursor: 'next' })
  expect(f.root.textContent).not.toContain('加载更多')
})

it('distinguishes disconnected and failed reads from an empty archive', async () => {
  const f = await mount()
  f.ready.value = false
  await nextTick()
  expect(f.root.textContent).toContain('服务尚未就绪')
  expect(f.root.querySelector<HTMLInputElement>('input')?.disabled).toBe(true)
  expect(f.root.textContent).not.toContain('没有匹配的任务')
  f.list.mockRejectedValueOnce(new Error('archive read failed'))
  f.ready.value = true
  await vi.waitFor(() => expect(f.root.textContent).toContain('本地任务操作失败'))
  expect(f.root.textContent).not.toContain('没有匹配的任务')
  f.list.mockResolvedValueOnce({ items: [], nextCursor: null })
  f.notify()
  await vi.waitFor(() => expect(f.root.textContent).toContain('没有匹配的任务'))
})
