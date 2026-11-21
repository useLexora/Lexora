// @vitest-environment jsdom
import type { LocalRun } from '@buddy-shared/runs/runApi'
import type { useReaderBridge } from '../readerBridge'
import type { ReaderActionInput, ReaderMessage } from '../readerProtocol'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import MobileReader from '../MobileReader.vue'

let bridge: ReturnType<typeof useReaderBridge>
const actions: ReaderActionInput[] = []
vi.mock('../readerBridge', async (getOriginal) => {
  const original = await getOriginal<typeof import('../readerBridge')>()
  return { ...original, useReaderBridge() {
    bridge = original.useReaderBridge()
    return { ...bridge, send: (action: ReaderActionInput) => actions.push(action) }
  } }
})
const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach(fn => fn())
  actions.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const run: LocalRun = { id: 'run', buddyId: 'actor', branchId: 'branch', conversationId: 'task', triggeringMessageId: 'user', status: 'running', startedAt: '2026-11-11T05:00:00Z', completedAt: null, errorCode: null, approvalPolicy: 'manual', executionProfile: 'read_only', modelId: 'model', providerId: 'provider', purpose: 'chat', reasoningLevel: null }
function message(id: string, text: string, role: 'assistant' | 'user'): ReaderMessage {
  return { id, text, role, runId: role === 'user' ? null : run.id, authorId: null, author: 'Lexora', final: true, markdown: false, interrupted: false, truncated: false, showIdentity: false, intermediate: false, toolName: null, toolSummary: '', toolTitle: '', toolError: false, needsDetail: false, loading: false, error: null, notice: null, hasDetail: false, detailResource: null, actionsVisible: false, canEdit: false, canRegenerate: false, canFollowup: false, canCopy: false, resources: [] }
}

it('shows private thinking as a summary and keeps public narration read-only after completion', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const root = document.createElement('div')
  const app = createApp(MobileReader)
  app.mount(root)
  cleanups.push(() => app.unmount())
  bridge.topic.value = 'branch'
  bridge.turnWindow.value = true
  bridge.runs.value = [run]
  const group = { id: 'group:first', runId: run.id, afterMessageId: 'input', createdAt: run.startedAt, toolCount: 200, reasoningCount: 1, runningReasoningCount: 0, interruptedReasoningCount: 0, failedCount: 1, interruptedCount: 0, runningCount: 1, activeToolName: 'bash', counts: [{ category: 'command' as const, count: 200 }] }
  bridge.entries.value = [
    { id: 'user', continuation: false, messages: [message('user', 'Build the APK', 'user')] },
    { id: 'first', continuation: false, messages: [message('first', 'I found the signing issue.', 'assistant')] },
    { id: group.id, continuation: true, messages: [], activityGroup: { ...group, toolCount: 0, failedCount: 0, runningCount: 0, runningReasoningCount: 1, activeToolName: null, counts: [] } },
  ]
  await nextTick()
  expect(root.querySelector('[data-activity-id]')?.textContent).toContain('正在思考')
  expect(root.querySelector('[data-activity-id] button')).toBeNull()
  bridge.entries.value = [...bridge.entries.value.slice(0, 2), { ...bridge.entries.value[2]!, activityGroup: group }]
  await nextTick()
  expect(actions.filter(action => action.action !== 'outputs')).toEqual([])
  bridge.runs.value = [{ ...run, status: 'completed', completedAt: run.startedAt }]
  bridge.entries.value = [...bridge.entries.value.slice(0, 2), { ...bridge.entries.value[2]!, activityGroup: { ...group, activeToolName: null, runningCount: 0 } }, { id: 'result', continuation: true, messages: [{ ...message('result', 'APK ready', 'assistant'), commentary: { text: 'Build succeeded.', range: { revision: `c:${'a'.repeat(64)}`, start: 0, end: 16, total: 16 } } }] }]
  await nextTick()
  expect(root.textContent).toMatch(/I found the signing issue\.[\s\S]*Build succeeded\.[\s\S]*APK ready/)
  const commentary = root.querySelector<HTMLElement>('[data-message-id="result"] .reader-narration')!
  expect(commentary.querySelector('button')).toBeNull()
  commentary.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
  expect(actions.filter(action => action.action !== 'outputs')).toEqual([])
})
