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

function mountReader(height = 600) {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height)
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
  return root
}

it.each([180, 600])('uses one latest control for a previous window at height %i, retrying only on intent', async (height) => {
  const root = mountReader(height)
  bridge.runs.value = []
  bridge.entries.value = [{ id: 'found', continuation: false, messages: [message('found', 'Located text', 'user')] }]
  bridge.hasLaterMessages.value = true
  if (height === 600)
    bridge.anchor.value = { topic: 'branch', messageId: 'found', requestId: 'search' }
  bridge.history.value = { available: true, loading: false, error: 'earlier failed' }
  await nextTick()
  const viewport = root.querySelector<HTMLElement>('.reader-viewport')!
  const latest = () => root.querySelector<HTMLButtonElement>('.latest-button')!
  const requests = () => actions.filter(action => action.action === 'latest')
  function pull(dy: number, dx = 0) {
    for (const [type, y] of [['touchstart', 0], ['touchmove', dy], ['touchend', dy]] as const) {
      const point = { identifier: 1, clientY: y, clientX: y ? dx : 0 }
      viewport.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { touches: type === 'touchend' ? [] : [point], changedTouches: [point] }))
    }
  }
  expect(root.querySelectorAll('.latest-button')).toHaveLength(1)
  const control = latest()
  control.click()
  expect(requests()).toHaveLength(1)
  bridge.latestState.value = { loading: true, error: null }
  await nextTick()
  expect(latest()).toBe(control)
  expect(control.disabled).toBe(true)
  expect(control.querySelector('.latest-spinner')).not.toBeNull()
  expect(root.querySelector('.history-progress')).toBeNull()
  pull(100)
  bridge.latestState.value = { loading: false, error: 'offline' }
  await nextTick()
  expect(control.ariaLabel).toContain('offline')
  expect(control.querySelector('.latest-spinner')).toBeNull()
  expect(root.querySelector('[data-message-id="found"]')).not.toBeNull()
  pull(40)
  pull(100, 85)
  viewport.scrollTop = 80
  pull(100)
  viewport.scrollTop = 0
  const selecting = vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false, toString: () => 'selected' } as Selection)
  pull(100)
  selecting.mockRestore()
  expect(requests()).toHaveLength(1)
  pull(80)
  expect(requests()).toHaveLength(2)
  expect(actions.some(action => action.action === 'older')).toBe(false)
  bridge.hasLaterMessages.value = false
  bridge.anchor.value = null
  bridge.latestState.value = { loading: false, error: null }
  await nextTick()
  expect(latest()).toBeNull()
  pull(100)
  expect(requests()).toHaveLength(2)
})

it('keeps state at its visible owner and never lets another run or overscan consume the only hint', async () => {
  const root = mountReader(180)
  const user = { id: 'user', continuation: false, messages: [message('user', 'Build', 'user')] }
  const body = { id: 'body', continuation: true, messages: [{ ...message('body', 'First line', 'assistant'), final: false }] }
  const activityGroup = { id: 'group', runId: run.id, afterMessageId: 'user', createdAt: run.startedAt, toolCount: 1, reasoningCount: 0, runningReasoningCount: 0, interruptedReasoningCount: 0, failedCount: 0, interruptedCount: 0, runningCount: 1, activeToolName: 'read', counts: [{ category: 'read' as const, count: 1 }] }
  const tool = { id: activityGroup.id, continuation: true, messages: [], activityGroup }
  const hint = () => root.querySelector('.run-hint')?.textContent
  bridge.runs.value = [{ ...run, status: 'queued' }]
  bridge.entries.value = [user]
  await nextTick()
  expect(hint()).toBe('已排队')
  bridge.runs.value = [run]
  bridge.entries.value = [user, body]
  await nextTick()
  expect(root.querySelector('[data-message-id="body"] .message-author .stream-status')?.textContent).toBe('正在回复')
  expect(root.querySelector('[data-entry-id^="run-status:"]')).toBeNull()
  expect(hint()).toBeUndefined()
  bridge.entries.value = [user, tool]
  await nextTick()
  expect(root.querySelector('[data-activity-id]')?.textContent).toContain('运行中 · read')
  expect(root.querySelector('.stream-status')).toBeNull()
  expect(hint()).toBeUndefined()
  bridge.entries.value = [body, tool]
  await nextTick()
  expect(root.querySelector('.stream-status')).toBeNull()
  bridge.hasLaterMessages.value = true
  await nextTick()
  expect(hint()).toBe('运行中')
  expect(root.querySelector('[data-activity-id]')?.textContent).not.toContain('运行中')
  bridge.hasLaterMessages.value = false
  bridge.entries.value = [user, tool]
  bridge.runs.value = [run, { ...run, id: 'other', status: 'queued', triggeringMessageId: 'not-on-page' }]
  await nextTick()
  expect(hint()).toBe('另有任务排队中')
  bridge.entries.value = [user, { ...user, id: 'older', messages: [message('older', 'Past input', 'user')] }, { ...user, id: 'nearby', messages: [message('nearby', 'Past input', 'user')] }, tool]
  await nextTick()
  expect(root.querySelector('[data-activity-id]')).not.toBeNull() // mounted by overscan but outside the reading area
  expect(hint()).toBe('运行中')
  expect(root.querySelectorAll('.run-hint')).toHaveLength(1)
  bridge.topic.value = 'other-branch'
  bridge.runs.value = []
  bridge.entries.value = [user]
  await nextTick()
  expect(hint()).toBeUndefined()
})

it('keeps no-reply outputs on their run through the terminal state and does not duplicate a successful reply', async () => {
  const root = mountReader()
  bridge.entries.value = [{ id: 'user', continuation: false, messages: [{ ...message('user', 'Build', 'user'), branchId: 'base' }] }]
  bridge.branches.value = [
    { id: 'base', conversationId: 'task', createdAt: run.startedAt, forkedFromMessageId: null, parentBranchId: null },
    { id: run.branchId, conversationId: 'task', createdAt: run.startedAt, forkedFromMessageId: 'user', parentBranchId: 'base' },
  ]
  bridge.selectedBranchId.value = run.branchId
  bridge.outputs.value = { [run.id]: { failed: false, items: [{ id: 'artifact:doc', revision: '1', name: 'result.txt', description: 'Text', available: true, image: false, thumbnail: null }] } }
  for (const [status, label] of [['running', null], ['cancelled', '已停止'], ['failed', '失败'], ['completed', '未生成回复']] as const) {
    bridge.runs.value = [{ ...run, status }]
    await nextTick()
    expect(root.querySelector('[data-output-run-id="run"]')?.textContent).toContain('result.txt')
    expect(root.querySelector('[data-entry-id="run-status:run"] [role="status"]')?.textContent ?? null).toBe(label)
    if (status !== 'running')
      expect(root.querySelector('[data-entry-id="run-status:run"] .message-branches')?.textContent).toContain('2/2')
  }
  bridge.entries.value = [...bridge.entries.value, { id: 'answer', continuation: true, messages: [message('answer', 'Output attached', 'assistant')] }]
  await nextTick()
  expect(root.querySelector('[data-entry-id="run-status:run"]')).toBeNull()
  expect(root.querySelector('[data-message-id="answer"] [data-output-run-id="run"]')?.textContent).toContain('result.txt')
})

it('attributes a returning group only to a proven different public actor, not a sibling or the current buddy', async () => {
  const root = mountReader()
  const said = (runId: string, authorId: string, author: string) => ({ id: runId, continuation: false, messages: [{ ...message(runId, 'Done', 'assistant'), runId, authorId, author }] })
  const group = { id: 'group', runId: run.id, afterMessageId: null, createdAt: run.startedAt, toolCount: 1, reasoningCount: 0, runningReasoningCount: 0, interruptedReasoningCount: 0, failedCount: 0, interruptedCount: 0, runningCount: 0, activeToolName: null, counts: [{ category: 'read' as const, count: 1 }] }
  const activity = { id: group.id, continuation: true, messages: [], activityGroup: group }
  const rootMessage = said(run.id, run.buddyId, 'Root snapshot')
  const child = said('child', 'actor-2', 'Child snapshot')
  const owner = () => root.querySelector('[data-entry-id="group"] .group-owner')?.textContent
  bridge.runs.value = [{ ...run, executionKind: 'root' }]
  bridge.entries.value = [rootMessage, child, activity]
  await nextTick()
  expect(owner()).toBe('Root snapshot')
  bridge.entries.value = [child, rootMessage, activity]
  await nextTick()
  expect(owner()).toBeUndefined()
  bridge.entries.value = [child, activity]
  await nextTick()
  expect(owner()).toBe('主任务的操作')
  bridge.runs.value = []
  await nextTick()
  expect(owner()).toBeUndefined()
  const childGroup = { ...activity, activityGroup: { ...group, runId: 'child' } }
  bridge.entries.value = [child, rootMessage, childGroup]
  await nextTick()
  expect(owner()).toBe('Child snapshot')
  bridge.entries.value = [rootMessage, { ...activity, activityGroup: { ...group, runId: 'unknown' } }]
  await nextTick()
  expect(owner()).toBeUndefined()
})

it('keeps user editing separate from failed-input recovery and never offers an empty more menu', async () => {
  const root = mountReader()
  const input = { ...message('input', 'My input', 'user'), actionsVisible: true, canEdit: true, canCopy: true }
  for (const recovery of [undefined, true, false]) {
    bridge.entries.value = [{ id: input.id, messages: [{ ...input, returnToComposer: recovery }], continuation: false }]
    await nextTick()
    const footer = root.querySelector<HTMLElement>('.user .message-actions')!
    expect(footer.querySelector('[aria-label="更多消息操作"]')).toBeNull()
    const edit = footer.querySelector<HTMLButtonElement>('[aria-label="编辑消息"]')
    const restore = footer.querySelector<HTMLButtonElement>('.return-to-composer')
    expect(Boolean(edit)).toBe(recovery === undefined)
    expect(Boolean(restore)).toBe(recovery === true)
    const button = edit ?? restore
    if (button) {
      button.click()
      expect(actions.at(-1)).toEqual({ action: 'edit', id: 'input' })
    }
  }
})

it('uses the live buddy only on a current public legacy run header without replies', async () => {
  const root = mountReader()
  bridge.turnWindow.value = false
  bridge.entries.value = [{ id: 'user', continuation: false, messages: [message('user', 'Go', 'user')] }]
  const actor = { ...run, buddyId: 'npc-reviewer', executionKind: 'actor_child' as const }
  bridge.buddyNames.value = new Map([[actor.buddyId, 'Reviewer']])
  bridge.selectedBranchId.value = actor.branchId
  bridge.runs.value = [actor]
  const name = () => root.querySelector('.reader-turn .author-name')?.textContent
  const photo = () => root.querySelector('.reader-turn .message-avatar img')?.getAttribute('src')
  await nextTick()
  expect(name()).toBe('Reviewer')
  const liveAvatar = photo()
  expect(liveAvatar).toBeTruthy()
  bridge.runs.value = [{ ...actor, executionKind: 'root', status: 'queued' }]
  bridge.buddyNames.value = new Map([[actor.buddyId, 'Renamed']])
  await nextTick()
  expect(name()).toBe('Renamed')
  bridge.hasLaterMessages.value = true
  await nextTick()
  expect(name()).toBe('助手')
  const neutralAvatar = photo()
  expect(neutralAvatar).toBeTruthy()
  expect(neutralAvatar).not.toBe(liveAvatar)
  bridge.hasLaterMessages.value = false
  bridge.language.value = 'en'
  bridge.runs.value = [{ ...actor, executionKind: undefined }]
  await nextTick()
  expect([name(), photo()]).toEqual(['Assistant', liveAvatar])
  for (const unproven of [{ ...actor, status: 'completed' as const }, { ...actor, branchId: 'other' }]) {
    bridge.runs.value = [unproven]
    await nextTick()
    expect([name(), photo()]).toEqual(['Assistant', neutralAvatar])
  }
})

it('keeps same-run message snapshots authoritative and never borrows a directory or previous author for a missing snapshot', async () => {
  const root = mountReader()
  bridge.turnWindow.value = false
  bridge.runs.value = [{ ...run, buddyId: 'npc-reviewer', executionKind: 'root' }]
  bridge.buddyNames.value = new Map([['npc-reviewer', 'Current reviewer'], ['npc-explorer', 'Current explorer']])
  bridge.transcripts.value = { [run.id]: { loaded: true, events: [
    { runId: run.id, createdAt: run.startedAt, sequence: 1, type: 'message.completed', payload: { messageId: 'final', phase: 'final_answer', content: { text: 'Done' } } },
  ] } }
  const unknown = { ...message('note', 'Progress', 'assistant'), author: '助手', showIdentity: true }
  const saved = { ...message('final', 'Done', 'assistant'), authorId: 'npc-explorer', author: 'Explorer then', showIdentity: true }
  const row = (reply: ReaderMessage) => ({ id: reply.id, continuation: false, messages: [reply] })
  const name = () => root.querySelector('.reader-turn .author-name')?.textContent
  const photo = () => root.querySelector('.reader-turn .message-avatar img')?.getAttribute('src')
  bridge.entries.value = [row(unknown), row(saved)]
  await nextTick()
  expect(name()).toBe('Explorer then')
  const savedAvatar = photo()
  bridge.entries.value = [row({ ...saved, runId: 'previous' }), row(unknown)]
  await nextTick()
  expect(name()).toBe('助手')
  expect(photo()).not.toBe(savedAvatar)
  bridge.turnWindow.value = true
  await nextTick()
  expect(root.querySelector('[data-message-id="note"] .author-name')?.textContent).toBe('助手')
  expect(root.querySelector('[data-message-id="final"] .author-name')?.textContent).toBe('Explorer then')
})

it('keeps the old transcript mixed narration selectable and its distinct result footer usable', async () => {
  const root = mountReader()
  bridge.turnWindow.value = false
  bridge.runs.value = [{ ...run, status: 'completed' }]
  bridge.entries.value = [{ id: 'same', continuation: false, messages: [{ ...message('same', 'The answer', 'assistant'), actionsVisible: true, canCopy: true, canFollowup: true }] }]
  bridge.transcripts.value = { [run.id]: { loaded: true, events: [
    { runId: run.id, createdAt: run.startedAt, sequence: 1, type: 'message.delta', payload: { messageId: 'same', contentIndex: 0, phase: 'commentary', delta: 'Checking' } },
    { runId: run.id, createdAt: run.startedAt, sequence: 2, type: 'message.completed', payload: { messageId: 'same', phase: 'final_answer', content: { text: 'The answer' } } },
  ] } }
  await nextTick()
  const note = root.querySelector('.reader-turn .reader-narration')!
  expect(note.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(true)
  expect(actions.some(action => action.action === 'message')).toBe(false)
  const result = root.querySelector('[data-message-id="same"]')!
  expect(result.textContent).toContain('The answer')
  result.querySelector<HTMLButtonElement>('[aria-label="更多消息操作"]')!.click()
  expect(actions.at(-1)).toMatchObject({ action: 'message', id: 'same' })
})

it('shows private thinking as a summary and keeps public narration read-only after completion', async () => {
  const root = mountReader()
  const group = { id: 'group:first', runId: run.id, afterMessageId: 'input', createdAt: run.startedAt, toolCount: 200, reasoningCount: 1, runningReasoningCount: 0, interruptedReasoningCount: 0, failedCount: 1, interruptedCount: 0, runningCount: 1, activeToolName: 'bash', counts: [{ category: 'command' as const, count: 200 }] }
  bridge.entries.value = [
    { id: 'user', continuation: false, messages: [message('user', 'Build the APK', 'user')] },
    { id: 'first', continuation: false, messages: [{ ...message('first', 'I found the signing issue.', 'assistant'), intermediate: true }] },
    { id: group.id, continuation: true, messages: [], activityGroup: { ...group, toolCount: 0, failedCount: 0, runningCount: 0, runningReasoningCount: 1, activeToolName: null, counts: [] } },
  ]
  await nextTick()
  expect(root.querySelector('[data-activity-id]')?.textContent).toContain('正在思考')
  expect(root.querySelector('[data-activity-id] button')).toBeNull()
  bridge.entries.value = [...bridge.entries.value.slice(0, 2), { ...bridge.entries.value[2]!, activityGroup: group }]
  await nextTick()
  expect(actions.filter(action => action.action !== 'outputs')).toEqual([])
  bridge.runs.value = [{ ...run, status: 'completed', completedAt: run.startedAt }]
  bridge.entries.value = [...bridge.entries.value.slice(0, 2), { ...bridge.entries.value[2]!, activityGroup: { ...group, activeToolName: null, runningCount: 0 } }, { id: 'result', continuation: true, messages: [{ ...message('result', 'APK ready', 'assistant'), actionsVisible: true, canRegenerate: true, canFollowup: true, canCopy: true, commentary: { text: 'Build succeeded.', range: { revision: `c:${'a'.repeat(64)}`, start: 0, end: 16, total: 16 } } }] }]
  await nextTick()
  expect(root.textContent).toMatch(/I found the signing issue\.[\s\S]*Build succeeded\.[\s\S]*APK ready/)
  const commentary = root.querySelector<HTMLElement>('[data-message-id="result"] .reader-narration')!
  expect(commentary.querySelector('button')).toBeNull()
  for (const note of [root.querySelector<HTMLElement>('[data-message-id="first"] .message-body')!, commentary]) {
    const press = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    note.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(false)
  }
  expect(actions.filter(action => action.action !== 'outputs')).toEqual([])
  const footer = root.querySelector<HTMLElement>('[data-message-id="result"] .message-actions')!
  expect(Array.from(footer.querySelectorAll('button'), button => button.ariaLabel)).toEqual(['复制消息', '更多消息操作'])
  footer.querySelector<HTMLButtonElement>('[aria-label="更多消息操作"]')!.click()
  expect(actions.at(-1)).toMatchObject({ action: 'message', id: 'result' })
})
