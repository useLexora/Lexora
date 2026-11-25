// @vitest-environment jsdom
import type { ReaderActionInput, ReaderWireEntry } from '../readerProtocol'
import { afterEach, expect, it } from 'vitest'
import { createApp, h, nextTick, provide, shallowRef } from 'vue'
import { provideChatTranscriptPresentation } from '../../modules/tasks/reader'
import ReaderActivityGroup from '../ReaderActivityGroup.vue'
import { readerLanguageKey } from '../readerStrings'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

it('keeps a 200-call summary folded on arrival; discloses titles, a single saved message and subsequent pages separately', async () => {
  const group: NonNullable<ReaderWireEntry['activityGroup']> = { id: 'group:one', runId: 'run', afterMessageId: 'explanation', createdAt: '2026-11-11T05:00:00Z', runningCount: 1, activeToolName: 'bash', interruptedCount: 0, reasoningCount: 1, runningReasoningCount: 0, interruptedReasoningCount: 0, failedCount: 1, toolCount: 200, counts: [{ category: 'command', count: 200 }] }
  const failed = { id: 'call:73', toolName: 'bash', status: 'failed' as const, messageId: 'message:73' }
  const pending = { id: 'call:200', toolName: 'bash', summary: 'pnpm lint:fix', status: 'running' as const, messageId: null }
  const thinking = { id: 'thought:1', kind: 'reasoning' as const, toolName: 'reasoning', status: 'completed' as const, messageId: null }
  const tool = { id: 'call:74', toolName: 'lexora_agents', summary: 'Partners and NPCs', status: 'completed' as const, messageId: null }
  const steps = shallowRef<ReaderWireEntry['steps']>()
  const actions: ReaderActionInput[] = []
  const visible = shallowRef(true)
  const app = createApp({ setup() {
    provideChatTranscriptPresentation(() => 'branch', () => [group.id])
    provide(readerLanguageKey, shallowRef('zh'))
    return () => visible.value ? h(ReaderActivityGroup, { group, steps: steps.value, rowId: group.id, language: 'zh', send: action => actions.push(action) }) : null
  } })
  const root = document.createElement('div')
  app.mount(root)
  cleanups.push(() => app.unmount())
  const header = () => root.querySelector<HTMLButtonElement>('[aria-controls]')!
  expect(header().getAttribute('aria-expanded')).toBe('false')
  expect(root.textContent).toContain('运行 200 条命令')
  expect(root.textContent).toContain('1 项异常')
  expect(header().getAttribute('aria-label')).toBe('思考 · 运行 200 条命令')
  expect(header().textContent?.trim()).toBe('思考 · 运行 200 条命令')
  expect(actions).toEqual([])
  header().click()
  await nextTick()
  expect(actions).toEqual([{ action: 'activity-steps', groupId: group.id, runId: 'run' }])
  steps.value = { items: [thinking, failed, tool, pending], loading: false, failed: false, nextCursor: 'next' }
  await nextTick()
  const rows = Array.from(root.querySelectorAll('[data-step-id]'))
  expect(rows.map(row => row.getAttribute('data-step-id'))).toEqual([thinking.id, failed.id, tool.id, pending.id])
  expect(rows[0]!.textContent?.trim()).toBe('思考')
  expect(rows[0]!.querySelector('button')).toBeNull()
  expect(rows[1]!.textContent).toMatch(/运行命令\s*bash/) // older services have no command summary
  expect(rows[2]!.textContent).toMatch(/工具调用\s*Partners and NPCs/)
  expect(rows[3]!.textContent).toMatch(/运行命令\s*pnpm lint:fix/)
  expect(rows[3]!.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
  root.querySelector<HTMLButtonElement>('[data-step-id="call:73"] button')!.click()
  expect(actions.at(-1)).toEqual({ action: 'detail', id: 'message:73' })
  steps.value = { ...steps.value, items: [{ ...failed, detail: { loading: false, text: 'Build failed' } }, pending] }
  await nextTick()
  expect(root.querySelector('pre')?.textContent).toBe('Build failed')
  visible.value = false
  await nextTick()
  visible.value = true
  await nextTick()
  expect(header().getAttribute('aria-expanded')).toBe('true')
  expect(root.querySelector('pre')?.textContent).toBe('Build failed')
  expect(actions).toHaveLength(2)
  const more = [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === '加载更多')!
  more.click()
  expect(actions.at(-1)).toEqual({ action: 'activity-steps', groupId: group.id, runId: 'run', cursor: 'next' })
  steps.value = { ...steps.value, stale: true }
  await nextTick()
  expect(root.querySelector('pre')?.textContent).toBe('Build failed')
  expect(actions).toHaveLength(3)
  const refresh = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('步骤已更新'))!
  refresh.click()
  expect(actions.at(-1)).toEqual({ action: 'activity-steps', groupId: group.id, runId: 'run' })
})
