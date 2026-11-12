// @vitest-environment jsdom
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { TaskArchiveActions } from '../../../contracts'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopTaskArchiveAction from '../DesktopTaskArchiveAction.vue'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  document.body.innerHTML = ''
})
function task(id: string, activity: LocalConversationSummary['activity']): LocalConversationSummary {
  return { id, title: id, activity, buddyId: 'default', activeBranchId: `branch-${id}`, spaceId: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', deletedAt: null, archivedAt: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', modelSelection: null, automationOccurrence: null, metadataRevision: 4 }
}
async function mount(activity: LocalConversationSummary['activity']) {
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }))
  const target = shallowRef<LocalConversationSummary | null>(task('task-one', activity))
  const ready = shallowRef(true)
  const revision = shallowRef(5)
  const archive = vi.fn<TaskArchiveActions['archive']>().mockResolvedValue(true)
  const restore = vi.fn<TaskArchiveActions['restore']>().mockResolvedValue(true)
  const actions: TaskArchiveActions = { onChanged: () => () => {}, get: vi.fn(async id => ({ ...task(id, 'idle'), archivedAt: '2026-09-02T00:00:00Z', metadataRevision: revision.value })), ready, archive, restore, delete: vi.fn(), list: vi.fn(), getPolicy: vi.fn(), setPolicy: vi.fn() }
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ render: () => h(DesktopTaskArchiveAction, { 'actions': actions, 'language': 'zh-CN', 'target': target.value, 'onUpdate:target': value => target.value = value }) })
  app.mount(root)
  cleanups.push(() => app.unmount())
  await nextTick()
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === label)!
  return { target, ready, revision, archive, restore, button }
}

it('requires stop-and-archive consent for active work without offering execution restoration', async () => {
  const f = await mount('running')
  expect(document.body.textContent).toContain('停止此任务及其子执行')
  expect(document.body.textContent).toContain('取消归档不会自动恢复执行或权限')
  expect(f.archive).not.toHaveBeenCalled()
  f.ready.value = false
  await nextTick()
  expect(f.button('停止并归档').disabled).toBe(true)
  f.ready.value = true
  await nextTick()
  f.button('停止并归档').click()
  await vi.waitFor(() => expect(f.target.value).toBeNull())
  expect(f.archive.mock.calls).toEqual([['task-one', 4]])
  expect(f.button('撤销归档')).toBeUndefined()
})

it('offers explicit undo for idle archiving and never clears a replacement target on late completion', async () => {
  const f = await mount('idle')
  f.button('归档').click()
  await vi.waitFor(() => expect(f.target.value).toBeNull())
  await vi.waitFor(() => expect(f.button('撤销归档').disabled).toBe(false))
  f.revision.value = 6
  f.button('撤销归档').click()
  await vi.waitFor(() => expect(f.restore.mock.calls).toEqual([['task-one', 5]]))
  const gate = deferred<boolean>()
  f.archive.mockReturnValueOnce(gate.promise)
  f.target.value = task('task-two', 'idle')
  await nextTick()
  f.button('归档').click()
  f.target.value = task('task-three', 'idle')
  gate.resolve(true)
  await nextTick()
  await nextTick()
  expect(f.target.value?.id).toBe('task-three')
  expect(document.body.textContent).toContain('task-three')
})
