import type { DropdownOption } from 'naive-ui'
import type { TaskEnvironment } from '@/modules/tasks/taskContext'
import { deferred } from '@buddy-tests/deferred'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowRef } from 'vue'
import { parseSessionReferenceClipboard } from '@/modules/tasks/model/sessionReferenceClipboard'
import { conversation, page } from '@/modules/tasks/model/transcript/__tests__/conversationMarkdownFixtures'
import { createConversationExport } from '@/modules/tasks/state/conversations/conversationExport'
import { useTaskMenuActions } from '../useTaskMenuActions'

const state = vi.hoisted(() => ({ environment: {} as TaskEnvironment, destroy: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn() }))
vi.mock('@/modules/tasks/taskContext', () => ({ useTaskEnvironment: () => state.environment }))
vi.mock('naive-ui', async original => ({
  ...await original<typeof import('naive-ui')>(),
  useMessage: () => ({ success: state.success, error: state.error, loading: state.loading }),
}))
beforeEach(() => {
  state.loading.mockReturnValue({ destroy: state.destroy })
})
function fixture() {
  const get = vi.fn().mockResolvedValue(conversation())
  const listTimeline = vi.fn().mockResolvedValue(page())
  const writeText = vi.fn().mockResolvedValue(undefined)
  const exporter = createConversationExport({ api: { get, listTimeline }, clipboard: { writeText } })
  state.environment = { clipboard: { writeText }, conversationExport: exporter } as unknown as TaskEnvironment
  const task = shallowRef({ taskId: 'conversation' as string | null, title: 'original title', marks: [], marksBusy: false })
  const options = { task: () => task.value, language: () => 'zh-CN' as const, assignMark: vi.fn(), clearMarks: vi.fn(), setRead: vi.fn() }
  const first = useTaskMenuActions(options)
  const second = useTaskMenuActions(options)
  const markdownItem = (menu = first) => (menu.actions.value.find(option => option.key === 'copy') as DropdownOption).children!.find(option => option.key === 'copy-markdown') as DropdownOption
  return { first, second, task, get, listTimeline, writeText, markdownItem, exporter }
}

describe('task copy menu', () => {
  it('exposes Markdown in the shared menu and leaves all existing copy payloads unchanged', async () => {
    const f = fixture()
    expect(f.markdownItem().label).toBe('复制为 Markdown')
    const children = (f.first.actions.value.find(option => option.key === 'copy') as DropdownOption).children!
    expect(children.map(option => option.key)).toEqual(['copy-task-reference', 'copy-reference-divider', 'copy-task-id', 'copy-title', 'copy-markdown'])
    expect(children[1]).toMatchObject({ type: 'divider' })
    f.first.select('copy-title')
    f.first.select('copy-task-id')
    f.first.select('copy-task-reference')
    expect(f.writeText.mock.calls[0]![0]).toBe('original title')
    expect(f.writeText.mock.calls[1]![0]).toBe('conversation')
    expect(parseSessionReferenceClipboard(f.writeText.mock.calls[2]![0])).toEqual({ references: [{ id: 'conversation', title: 'original title' }], text: '' })
    expect(f.listTimeline).not.toHaveBeenCalled()
    f.task.value = { ...f.task.value, taskId: null }
    expect(f.first.actions.value).toEqual([])
    f.first.select('copy-markdown')
    expect(state.loading).not.toHaveBeenCalled()
  })

  it('disables both menus during export, binds the original target, and reports the actual title', async () => {
    const f = fixture()
    const waiting = deferred<ReturnType<typeof page>>()
    f.listTimeline.mockReturnValue(waiting.promise)
    f.first.select('copy-markdown')
    expect(f.markdownItem().disabled).toBe(true)
    expect(f.markdownItem(f.second).disabled).toBe(true)
    f.task.value = { ...f.task.value, taskId: 'different', title: 'different title' }
    f.second.select('copy-markdown')
    waiting.resolve(page())
    await vi.waitFor(() => expect(state.success).toHaveBeenCalledWith('已将“排查启动失败”复制为 Markdown'))
    expect(f.get.mock.calls.every(call => call[0] === 'conversation')).toBe(true)
    expect(f.writeText).toHaveBeenCalledTimes(1)
    expect(state.loading).toHaveBeenCalledTimes(1)
    expect(state.destroy).toHaveBeenCalledTimes(1)
    expect(f.markdownItem().disabled).toBe(false)
  })

  it.each(['read', 'clipboard', 'size'])('reports a %s failure without a success toast', async (failure) => {
    const f = fixture()
    if (failure === 'read')
      f.listTimeline.mockRejectedValue(new Error('offline'))
    if (failure === 'clipboard')
      f.writeText.mockRejectedValue(new Error('unavailable'))
    if (failure === 'size')
      state.environment.conversationExport = createConversationExport({ api: { get: f.get, listTimeline: f.listTimeline }, clipboard: { writeText: f.writeText }, maxReadBytes: 1 })
    // Recreate the menu after replacing the environment capability.
    const menu = useTaskMenuActions({ task: () => f.task.value, language: () => 'zh-CN', assignMark() {}, clearMarks() {}, setRead() {} })
    menu.select('copy-markdown')
    await vi.waitFor(() => expect(state.error).toHaveBeenCalledWith(failure === 'size' ? '会话内容过大，暂无法一次复制' : '复制失败，请重试'))
    expect(state.success).not.toHaveBeenCalled()
    expect(state.destroy).toHaveBeenCalledTimes(1)
    if (failure !== 'clipboard')
      expect(f.writeText).not.toHaveBeenCalled()
  })
})
