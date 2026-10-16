// @vitest-environment jsdom
import type { ChatAgentPanelNode, ChatAgentToolNode, ChatAgentTurn, ChatAgentTurnNode } from '../../../model/transcript/chatAgentTurn'
import { DEFAULT_DESKTOP_CHAT_PREFERENCES } from '@buddy-electron/shared/desktopApi'
import { NMessageProvider } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { useProvideDesktopUi } from '@/shared/ui/desktopUiContext'
import { projectExtensionActionTool } from '../../../model/transcript/chatTranscriptActivities'
import BuddyChatAgentTurn from '../BuddyChatAgentTurn.vue'
import BuddyChatRunActivity from '../BuddyChatRunActivity.vue'
import { useProvideChatContent } from '../chatContentContext'

vi.mock('../BuddyChatActionToolbar.vue', () => ({ default: { render: () => null } }))
const cleanups: (() => void)[] = []
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })
})
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  vi.useRealTimers()
})

describe('activity disclosure', () => {
  it('preserves panel disclosure across mixed actors, appended records and turn completion, with bottom collapse returning focus', async () => {
    const first = panel('first')
    const { root, turn } = mountTurn([first])
    expect(root.querySelector('.buddy-chat-panel-group__header')).toBeNull()
    expect(root.querySelector('[data-testid="context-panel-operation"]')?.textContent).toBe('你 · 已展开资源面板')
    turn.value = { ...turn.value, nodes: [first, panel('second', 'harness', 'close')] }
    await nextTick()
    const header = root.querySelector<HTMLButtonElement>('.buddy-chat-panel-group__header')!
    expect(header.textContent).toBe('你与系统 · 资源面板操作 2 次')
    expect(header.getAttribute('aria-expanded')).toBe('false')
    header.click()
    await nextTick()
    turn.value = { ...turn.value, nodes: [...turn.value.nodes, panel('third')] }
    await nextTick()
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect([...root.querySelectorAll('[data-testid="context-panel-operation"]')].map(element => element.textContent?.trim())).toEqual(['你 · 已展开资源面板', '系统 · 已收起资源面板', '你 · 已展开资源面板'])
    header.click()
    await nextTick()
    turn.value = { ...turn.value, nodes: [...turn.value.nodes, ...Array.from({ length: 6 }, (_, index) => panel(`extra:${index}`, 'harness', index % 2 ? 'open' : 'close'))], status: 'completed', completedAt: '2026-09-09T00:00:10Z' }
    await nextTick()
    expect(header.textContent).toBe('你与系统 · 资源面板操作 9 次')
    expect(header.getAttribute('aria-expanded')).toBe('false')
    await vi.waitFor(() => expect(root.querySelector('[data-testid="context-panel-operation"]')).toBeNull())
    header.click()
    await nextTick()
    expect(root.querySelectorAll('[data-testid="context-panel-operation"]')).toHaveLength(9)
    root.querySelector<HTMLButtonElement>('.buddy-chat-panel-group__collapse')!.click()
    await nextTick()
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(header)
  })

  it('shows finite and unlimited retries with a live deadline and uninterrupted total duration', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-09T00:00:18Z'))
    const { root, turn } = mountTurn([])
    const retry = { attempt: 2, maxAttempts: 5, retryAt: '2026-09-09T00:00:25Z' }
    turn.value = { ...turn.value, progress: { phase: 'model_requesting', toolName: null, retry } }
    await nextTick()
    const status = () => root.querySelector('.buddy-chat-run-activity')!
    expect(status().textContent).toContain('7 秒后重试')
    expect(status().textContent).toMatch(/重试 2\s*\/\s*5/)
    expect(status().textContent).toContain('已用 18s')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(status().textContent).toContain('4 秒后重试')
    expect(status().textContent).toContain('已用 21s')
    turn.value = { ...turn.value, progress: { phase: 'model_requesting', toolName: null, retry: { ...retry, maxAttempts: 'unlimited' } } }
    await nextTick()
    expect(status().querySelector('[aria-label="不限次数"]')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(status().textContent).toContain('正在重试')
    expect(status().textContent).toContain('已用 25s')
    expect(status().textContent).not.toContain('0 秒后')
    turn.value = { ...turn.value, progress: { phase: 'model_streaming', toolName: null } }
    await nextTick()
    expect(status().textContent).toContain('正在处理')
    expect(status().textContent).not.toContain('重试')
    turn.value = { ...turn.value, status: 'cancelled', completedAt: '2026-09-09T00:00:25Z', progress: null }
    await nextTick()
    expect(root.querySelector('.buddy-chat-run-activity')).toBeNull()
  })

  it('keeps execution, approval, issues and stopping distinct through tool and model progress', async () => {
    const first = readTool('one', 'preparing')
    const second = readTool('two', 'failed')
    const { root, turn, stopping } = mountTurn([{ id: 'thought', contentIndex: 0, kind: 'reasoning', messageId: 'reply', status: 'completed', text: 'Checking output' }, first, second])
    const header = () => root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!
    const status = () => root.querySelector('.buddy-chat-run-activity')!
    header().click()
    await nextTick()
    expect(root.querySelector('.buddy-chat-activity-group__issues')?.textContent).toContain('1 项异常')
    expect(root.querySelector('[data-tool-call-id="one"]')?.textContent).toContain('准备')
    turn.value = { ...turn.value, nodes: [turn.value.nodes[0]!, { ...first, status: 'running' }, second] }
    await nextTick()
    expect(header().getAttribute('aria-label')).toContain('运行中')
    expect(root.querySelector('[data-tool-call-id="one"]')?.textContent).toContain('运行中')
    turn.value = { ...turn.value, nodes: [turn.value.nodes[0]!, { ...first, status: 'completed' }, second], progress: { phase: 'model_requesting', toolName: null } }
    await nextTick()
    expect(status().textContent).toContain('等待模型响应')
    expect(header().getAttribute('aria-expanded')).toBe('true')
    const pending = readTool('three', 'awaiting_approval')
    turn.value = { ...turn.value, nodes: [turn.value.nodes[0]!, { ...first, status: 'running' }, second, pending], progress: { phase: 'awaiting_approval', toolName: 'read' } }
    await nextTick()
    expect(root.querySelector('[data-tool-call-id="three"]')?.textContent).toContain('等待批准')
    expect(root.querySelector('.buddy-chat-activity-group__approval')?.textContent).toContain('1 项待批准')
    expect(root.querySelector('.buddy-chat-activity-group__issues')?.textContent).toContain('1 项异常')
    expect(status().textContent).toContain('有操作待批准')
    stopping.value = true
    await nextTick()
    expect(status().textContent).toContain('正在停止')
    stopping.value = false
    turn.value = { ...turn.value, nodes: [...turn.value.nodes.slice(0, 3), { ...pending, status: 'completed' }], progress: { phase: 'tool_executing', toolName: 'read' } }
    await nextTick()
    expect(status().textContent).toContain('正在执行')
    expect(status().textContent).not.toContain('待批准')
  })

  it('keeps a manually closed reasoning row closed as more blocks arrive and interruption settles it', async () => {
    const thought: ChatAgentTurnNode = { id: 'thought', contentIndex: 0, kind: 'reasoning', messageId: 'reply', status: 'completed', text: 'First thought' }
    const { root, turn } = mountTurn([thought])
    const header = () => root.querySelector<HTMLButtonElement>('.buddy-chat-reasoning-entry__header')!
    header().click()
    await nextTick()
    header().click()
    await nextTick()
    const following: ChatAgentTurnNode = { ...thought, id: 'following', contentIndex: 1, text: 'Following thought' }
    const active: ChatAgentTurnNode = { ...thought, id: 'active', contentIndex: 2, status: 'running', text: '' }
    turn.value = { ...turn.value, nodes: [thought, following, active] }
    await nextTick()
    expect(header().getAttribute('aria-expanded')).toBe('false')
    expect(header().textContent).toContain('正在思考')
    turn.value = { ...turn.value, nodes: [...turn.value.nodes, readTool('boundary', 'running')] }
    await nextTick()
    const group = root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!
    expect(group.getAttribute('aria-expanded')).toBe('false')
    turn.value = { ...turn.value, status: 'cancelled', nodes: [thought, following, { ...active, status: 'interrupted', text: 'Partial thought' }, readTool('boundary', 'cancelled')] }
    await nextTick()
    expect(group.getAttribute('aria-expanded')).toBe('false')
    group.click()
    await nextTick()
    expect(header().getAttribute('aria-expanded')).toBe('false')
    expect(header().textContent).toContain('已中断')
    await vi.waitFor(() => expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBeNull())
    header().click()
    await nextTick()
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')?.textContent).toContain('Partial thought')
  })

  it('keeps a manually closed tool closed when more calls form a group', async () => {
    const node = readTool('one', 'running')
    const { root, turn } = mountTurn([node])
    const header = root.querySelector<HTMLButtonElement>('.buddy-chat-tool__header')!
    header.click()
    await nextTick()
    header.click()
    await nextTick()
    turn.value = { ...turn.value, nodes: [node, readTool('next', 'running')] }
    await nextTick()
    expect(root.querySelector('.buddy-chat-activity-group__header')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('discloses long thoughts independently without truncation and retains the reader choice through group changes', async () => {
    const text = `The beginning\n\n${'Reasoning detail. '.repeat(5_000)}\n\nThe end`
    const thought: ChatAgentTurnNode = { id: 'long-thought', contentIndex: 0, kind: 'reasoning', messageId: 'reply', status: 'completed', text }
    const interrupted: ChatAgentTurnNode = { id: 'interrupted-thought', contentIndex: 0, kind: 'reasoning', messageId: 'reply', status: 'interrupted', text: 'Partial reasoning' }
    const { root, turn } = mountTurn([thought, readTool('one', 'completed'), interrupted], 'completed')
    const group = () => root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!
    group().click()
    await nextTick()
    const headings = () => [...root.querySelectorAll<HTMLButtonElement>('.buddy-chat-reasoning-entry__header')]
    expect(headings().map(header => header.textContent)).toEqual(['思考', '思考已中断'])
    headings()[0]!.click()
    await nextTick()
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim())
    group().click()
    await nextTick()
    await vi.waitFor(() => expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBeNull())
    group().click()
    await nextTick()
    expect(headings().map(header => header.getAttribute('aria-expanded'))).toEqual(['true', 'false'])
    root.querySelector<HTMLButtonElement>('.buddy-chat-reasoning-entry__collapse')!.click()
    await nextTick()
    expect(document.activeElement).toBe(headings()[0])
    turn.value = { ...turn.value, nodes: [...turn.value.nodes, readTool('two', 'completed')] }
    await nextTick()
    expect(headings().map(header => header.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
    await vi.waitFor(() => expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBeNull())
  })

  it('treats raw HTML in model narration as text', () => {
    const text = 'Review complete. <img src="https://example.com/tracker.png">'
    const { root } = mountTurn([{ id: 'narration', kind: 'text', messageId: 'narration', text }], 'completed')
    const body = root.querySelector('.buddy-chat-narration-body')!
    expect(body.querySelector('img')).toBeNull()
    expect(body.textContent).toContain('<img src="https://example.com/tracker.png">')
  })

  it('retains open output through leading reasoning, group collapse and model completion', async () => {
    const node = readTool('one', 'running')
    const { root, turn } = mountTurn([node])
    expect(root.querySelector('.buddy-chat-tool-details')).toBeNull()
    root.querySelector<HTMLButtonElement>('.buddy-chat-tool__header')!.click()
    await nextTick()
    const leading: ChatAgentTurnNode = { id: 'leading', contentIndex: 0, kind: 'reasoning', messageId: 'reply', status: 'completed', text: 'Checking the returned file' }
    turn.value = { ...turn.value, nodes: [leading, { ...node, status: 'completed' }, readTool('two', 'completed')], progress: { phase: 'model_responding', toolName: null } }
    await nextTick()
    const group = () => root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!
    expect(group().getAttribute('aria-expanded')).toBe('true')
    expect(root.querySelectorAll('.buddy-chat-tool-details')).toHaveLength(1)
    expect(root.querySelector('[data-tool-detail-id="one"]')?.textContent).toContain('File output')
    expect(root.querySelector('.buddy-chat-run-activity')?.textContent).toContain('正在回复')
    group().click()
    await nextTick()
    await vi.waitFor(() => expect(root.querySelector('.buddy-chat-tool-details')).toBeNull())
    group().click()
    await nextTick()
    expect(root.querySelector('[data-tool-call-id="one"] button')?.getAttribute('aria-expanded')).toBe('true')
    expect(root.querySelector('[data-tool-detail-id="one"]')?.textContent).toContain('File output')
    turn.value = { ...turn.value, status: 'completed', completedAt: '2026-09-09T00:00:10Z', progress: null }
    await nextTick()
    expect(root.querySelector('.buddy-chat-run-activity')).toBeNull()
    expect(root.querySelector('[data-tool-detail-id="one"]')?.textContent).toContain('File output')
  })

  it('retains individual read calls, accessible labels and open output as more calls arrive', async () => {
    const nodes = [readTool('one', 'completed'), readTool('two', 'completed'), readTool('three', 'awaiting_approval')]
    const { root, turn } = mountTurn(nodes)
    root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!.click()
    await nextTick()
    const second = root.querySelector<HTMLButtonElement>('[data-tool-call-id="two"] button')!
    expect(second.getAttribute('aria-label')).toContain('src/Row.vue')
    second.click()
    await nextTick()
    turn.value = { ...turn.value, nodes: [...nodes, readTool('four', 'completed')] }
    await nextTick()
    expect([...root.querySelectorAll('[data-tool-call-id]')].map(element => element.getAttribute('data-tool-call-id'))).toEqual(['one', 'two', 'three', 'four'])
    expect(root.querySelector('[data-tool-detail-id="two"]')?.textContent).toContain('File output')
    expect(root.querySelector('[data-tool-call-id="three"]')?.textContent).toContain('等待批准')
  })

  it('cycles extension and denied tool issues with accessible details and keyboard focus', async () => {
    const failed = projectExtensionActionTool({ kind: 'extension-action', id: 'naming', conversationId: 'conversation', branchId: 'branch', sourceMessageId: 'question', extensionId: 'tests.title', extensionName: 'Title', actionId: 'tests.title.generate', title: '重新生成标题', trigger: 'task:input:committed', status: 'failed', message: '模型不可用', createdAt: '2026-09-09T00:00:01Z', completedAt: '2026-09-09T00:00:02Z' })
    const { root } = mountTurn([failed, readTool('ok', 'completed'), readTool('denied', 'denied')])
    const issue = root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__issues')!
    expect(issue.textContent).toContain('2 项异常')
    expect(root.querySelector('.buddy-chat-tool-details')).toBeNull()
    issue.click()
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(root.querySelector('[data-action-id="naming"] button'))
    expect(root.querySelector('[data-action-detail-id="naming"]')?.textContent).toContain('模型不可用')
    issue.click()
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(root.querySelector('[data-tool-call-id="denied"]'))
    expect(root.querySelector('[data-tool-detail-id="denied"]')).toBeNull()
    issue.click()
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(root.querySelector('[data-action-id="naming"] button'))
    expect(root.querySelector('[data-action-detail-id="naming"]')?.textContent).toContain('模型不可用')
  })

  it('collapses a long group from its footer and returns keyboard focus to its header', async () => {
    const { root } = mountTurn(Array.from({ length: 12 }, (_, index) => readTool(String(index), 'completed')))
    const header = root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!
    header.click()
    await nextTick()
    root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__collapse')!.click()
    await nextTick()
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(header)
    await vi.waitFor(() => expect(root.querySelector('.buddy-chat-tool')).toBeNull())
  })

  it('keeps details usable when a disclosure is reopened before its leave transition finishes', async () => {
    const { root } = mountTurn([readTool('one', 'completed'), readTool('two', 'completed')])
    const header = root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!
    header.click()
    await nextTick()
    root.querySelector<HTMLButtonElement>('.buddy-chat-tool__header')!.click()
    await nextTick()
    header.click()
    await nextTick()
    header.click()
    await nextTick()
    await vi.waitFor(() => {
      expect(root.querySelectorAll('.buddy-chat-tool')).toHaveLength(2)
      expect(root.querySelectorAll('.buddy-chat-tool-details')).toHaveLength(1)
      expect(root.querySelector('.buddy-chat-activity-group__content')?.hasAttribute('inert')).toBe(false)
    })
    expect(root.querySelector('.buddy-chat-tool__header')?.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('current status and historical activity', () => {
  it('disables empty thoughts and retains open merged reasoning through grouping and interruption', async () => {
    const thought: ChatAgentTurnNode = { id: 'thought', kind: 'reasoning', messageId: 'reply', contentIndex: 0, status: 'running', text: '' }
    const { root, turn } = mountTurn([thought])
    const header = () => root.querySelector<HTMLButtonElement>('.buddy-chat-reasoning-entry__header')!
    expect(header().disabled).toBe(true)
    expect(header().textContent).toBe('正在思考')
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBeNull()
    turn.value = { ...turn.value, nodes: [{ ...thought, text: 'Checking the layout' }] }
    await nextTick()
    expect(header().disabled).toBe(false)
    header().click()
    await nextTick()
    const first: ChatAgentTurnNode = { ...thought, status: 'completed', text: 'Checking the layout' }
    const following: ChatAgentTurnNode = { ...thought, id: 'following', contentIndex: 1, text: 'More detail' }
    turn.value = { ...turn.value, nodes: [first, following, readTool('one', 'running')] }
    await nextTick()
    expect(root.querySelectorAll('.buddy-chat-reasoning-entry__header')).toHaveLength(1)
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')?.textContent).toContain('More detail')
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')?.textContent?.split('Checking the layout')).toHaveLength(2)
    expect(root.querySelector('.buddy-chat-activity-group__header')?.getAttribute('aria-expanded')).toBe('true')
    turn.value = { ...turn.value, status: 'cancelled', nodes: [first, { ...following, status: 'interrupted' }, readTool('one', 'cancelled')] }
    await nextTick()
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')?.textContent).toContain('More detail')
    expect(header().textContent).toBe('思考已中断')
    expect(root.querySelector('.buddy-chat-run-activity')).toBeNull()
  })

  it('keeps compaction boundaries and completed token counts while model progress continues', async () => {
    const history = [readTool('one', 'completed'), readTool('two', 'completed')]
    const { root, turn } = mountTurn(history)
    const compaction: ChatAgentTurnNode = { id: 'compact', kind: 'compaction', status: 'running', tokensBefore: null, estimatedTokensAfter: null }
    turn.value = { ...turn.value, nodes: [...history, compaction] }
    await nextTick()
    expect(root.querySelector('.buddy-chat-compaction')).toBeNull()
    expect(root.querySelector('.buddy-chat-run-activity')?.textContent).toContain('正在整理上下文')
    turn.value = { ...turn.value, nodes: [...history, { ...compaction, status: 'completed', tokensBefore: 4000, estimatedTokensAfter: 2000 }, readTool('after', 'completed')], progress: { phase: 'model_requesting', toolName: null } }
    await nextTick()
    expect(root.querySelectorAll('.buddy-chat-activity-group')).toHaveLength(2)
    expect(root.querySelector('.buddy-chat-compaction')?.textContent).toContain('上下文已整理')
    expect(root.querySelector('.buddy-chat-compaction')?.textContent).toContain('4,000 → 2,000 tokens')
    expect(root.querySelector('.buddy-chat-run-activity')?.textContent).toContain('等待模型响应')
  })
})

function panel(id: string, actor: ChatAgentPanelNode['actor'] = 'user', action: ChatAgentPanelNode['action'] = 'open'): ChatAgentPanelNode {
  return { id: `panel:${id}`, kind: 'panel', actor, action, status: 'completed' }
}

function mountTurn(nodes: ChatAgentTurnNode[], status: ChatAgentTurn['status'] = 'running') {
  const turn = shallowRef<ChatAgentTurn>({ branchId: 'branch', runId: 'run', completedAt: null, finalMessageId: null, nodes, processMessageIds: [], progress: null, reasoningLevel: null, startedAt: '2026-09-09T00:00:00Z', status, triggeringMessageId: 'question', usage: null })
  const stopping = shallowRef(false)
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    setup: () => {
      useProvideDesktopUi({
        userName: shallowRef(''),
        language: shallowRef('zh-CN'),
        isDark: shallowRef(false),
        appSidebarCollapsed: shallowRef(false),
        chat: shallowRef({ ...DEFAULT_DESKTOP_CHAT_PREFERENCES, permissionMode: 'policy_approval' }),
      })
      useProvideChatContent({ canPreviewFile: () => false, previewFile: () => {}, writeClipboardText: async () => {} })
      return () => h(NMessageProvider, null, { default: () => [
        h(BuddyChatAgentTurn, { language: 'zh-CN', turn: turn.value }),
        h(BuddyChatRunActivity, { language: 'zh-CN', turn: turn.value, stopping: stopping.value }),
      ] })
    },
  })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  return { root, turn, stopping }
}

function readTool(id: string, status: ChatAgentToolNode['status']): ChatAgentToolNode & { presentation: Extract<ChatAgentToolNode['presentation'], { card: 'read' }> } {
  return { id: `tool:${id}`, toolCallId: id, toolName: 'read', kind: 'tool', status, isError: false, description: null, presentation: { card: 'read', path: 'src/Row.vue', lineStart: 1, language: 'vue', description: null, output: 'File output', truncated: false } }
}
