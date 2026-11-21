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
  const pending = { id: 'call:200', toolName: 'bash', status: 'running' as const, messageId: null }
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
  expect(root.textContent).toContain('运行中 · bash')
  expect(actions).toEqual([])
  header().click()
  await nextTick()
  expect(actions).toEqual([{ action: 'activity-steps', groupId: group.id, runId: 'run' }])
  steps.value = { items: [failed, pending], loading: false, failed: false, nextCursor: 'next' }
  await nextTick()
  expect(root.querySelector<HTMLButtonElement>('[data-step-id="call:200"] button')!.getAttribute('aria-expanded')).toBe('false')
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
  root.querySelector<HTMLButtonElement>('.transcript-retry')!.click()
  expect(actions.at(-1)).toEqual({ action: 'activity-steps', groupId: group.id, runId: 'run', cursor: 'next' })
  steps.value = { ...steps.value, stale: true }
  await nextTick()
  expect(root.querySelector('pre')?.textContent).toBe('Build failed')
  expect(actions).toHaveLength(3)
  const refresh = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('步骤已更新'))!
  refresh.click()
  expect(actions.at(-1)).toEqual({ action: 'activity-steps', groupId: group.id, runId: 'run' })
})
