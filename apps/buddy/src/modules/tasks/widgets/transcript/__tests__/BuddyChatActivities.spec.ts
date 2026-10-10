// @vitest-environment jsdom
import type { ChatAgentToolNode, ChatAgentTurn, ChatAgentTurnNode } from '../../../model/transcript/chatAgentTurn'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { useProvideDesktopUi } from '@/shared/ui/desktopUiContext'
import { projectExtensionActionTool } from '../../../model/transcript/chatTranscriptActivities'
import BuddyChatAgentTurn from '../BuddyChatAgentTurn.vue'
import BuddyChatRunActivity from '../BuddyChatRunActivity.vue'
import { useProvideChatContent } from '../chatContentContext'

vi.mock('../BuddyChatActionToolbar.vue', () => ({ default: { render: () => null } }))
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.useRealTimers()
})

describe('activity disclosure', () => {
  it('shows finite and unlimited retries with a live deadline and uninterrupted total duration', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-09T00:00:18Z'))
    const { root, turn } = mountTurn([])
    const retry = { attempt: 2, maxAttempts: 5, retryAt: '2026-09-09T00:00:25Z' }
    turn.value = { ...turn.value, progress: { phase: 'model_requesting', toolName: null, retry } }
    await nextTick()
    const status = root.querySelector('.buddy-chat-run-activity')!
    expect(status.textContent).toContain('7 秒后重试')
    expect(status.querySelector('.buddy-chat-activity-loader')).toBeNull()
    expect(status.textContent).toMatch(/重试 2\s*\/\s*5/)
    expect(status.textContent).toContain('已用 18s')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(status.textContent).toContain('4 秒后重试')
    expect(status.textContent).toContain('已用 21s')
    turn.value = { ...turn.value, progress: { phase: 'model_requesting', toolName: null, retry: { ...retry, maxAttempts: 'unlimited' } } }
    await nextTick()
    expect(status.textContent).toMatch(/重试 2\s*\//)
    const unlimited = status.querySelector('.buddy-chat-run-activity__unlimited')!
    expect(unlimited.getAttribute('aria-label')).toBe('不限次数')
    expect(unlimited.querySelector('svg')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(status.textContent).toContain('正在重试')
    expect(status.textContent).toContain('已用 25s')
    expect(status.textContent).not.toContain('0 秒后')
    turn.value = { ...turn.value, progress: { phase: 'model_streaming', toolName: null } }
    await nextTick()
    expect(status.textContent).toContain('正在处理')
    expect(status.textContent).not.toContain('重试')
    turn.value = { ...turn.value, status: 'cancelled', completedAt: '2026-09-09T00:00:25Z', progress: null }
    await nextTick()
    expect(root.querySelector('.buddy-chat-run-activity')).toBeNull()
  })

  it('uses shared grouping, issue navigation and retained details for an independent action and built-in tool', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })
    cleanups.push(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    })
    const action = projectExtensionActionTool({ kind: 'extension-action', id: 'naming', conversationId: 'conversation', branchId: 'branch', sourceMessageId: 'question', extensionId: 'tests.title', extensionName: 'Title', actionId: 'tests.title.generate', title: '重新生成标题', trigger: 'task:input:committed', status: 'running', message: '正在生成', createdAt: '2026-09-09T00:00:01Z', completedAt: null })
    const { root, turn } = mountTurn([action])
    expect(root.querySelector('[data-action-status="running"]')?.textContent).toContain('重新生成标题')
    turn.value = { ...turn.value, nodes: [action, readTool('read', 'completed')] }
    await nextTick()
    const group = root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!
    expect(group.textContent).toContain('读取 1 个文件 · 工具调用 1 次')
    turn.value = { ...turn.value, nodes: [{ ...action, status: 'failed', isError: true, presentation: { card: 'generic', argumentNames: [], description: null, output: '模型不可用', truncated: false } }, turn.value.nodes[1]!] }
    await nextTick()
    root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__issues')!.click()
    await nextTick()
    await nextTick()
    const tool = root.querySelector<HTMLButtonElement>('[data-action-id="naming"] button')!
    expect(tool.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(tool)
    expect(root.querySelector('[data-action-detail-id="naming"]')?.textContent).toContain('模型不可用')
    group.click()
    await nextTick()
    await vi.waitFor(() => expect(root.querySelector('[data-action-detail-id="naming"]')).toBeNull())
    group.click()
    await nextTick()
    expect(root.querySelector('[data-action-detail-id="naming"]')?.textContent).toContain('模型不可用')
  })

  it('keeps a single tool and its open output stable while model progress runs independently', async () => {
    vi.useFakeTimers()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })
    cleanups.push(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    })
    const node: ChatAgentToolNode = { ...readTool('output', 'running'), toolName: 'lexora_output_present', presentation: { card: 'generic', argumentNames: ['paths'], description: null, output: 'Presented output', truncated: false } }
    const { root, turn } = mountTurn([node])
    expect(root.querySelector('.buddy-chat-run-activity')).not.toBeNull()
    root.querySelector<HTMLButtonElement>('.buddy-chat-tool__header')!.click()
    await nextTick()
    await nextTick()
    const header = root.querySelector<HTMLButtonElement>('.buddy-chat-tool__header')!
    expect(header.textContent).toContain('展示产物')
    expect(header.textContent).not.toContain('paths')
    const details = root.querySelector('.buddy-chat-tool-details')
    expect(details?.textContent).toContain('Presented output')
    for (const [phase, label] of [['model_requesting', '等待模型响应'], ['model_streaming', '正在处理'], ['model_responding', '正在回复']] as const) {
      turn.value = { ...turn.value, nodes: [{ ...node, status: 'completed' }], progress: { phase, toolName: null } }
      await nextTick()
      await vi.advanceTimersByTimeAsync(700)
      expect(root.querySelector('.buddy-chat-tool__header')).toBe(header)
      expect(header.textContent?.trim()).toBe('展示产物')
      expect(header.getAttribute('aria-expanded')).toBe('true')
      expect(root.querySelector('.buddy-chat-tool-details')).toBe(details)
      expect(root.querySelector('.buddy-chat-run-activity .buddy-chat-activity-status__label')?.textContent).toContain(label)
    }
    turn.value = { ...turn.value, finalMessageId: 'answer' }
    await nextTick()
    expect(root.querySelector('.buddy-chat-tool__header')).toBe(header)
    turn.value = { ...turn.value, status: 'completed', completedAt: '2026-09-09T00:00:10Z', progress: null }
    await nextTick()
    expect(root.querySelector('.buddy-chat-run-activity')).toBeNull()
    expect(root.querySelector('.buddy-chat-tool-details')).toBe(details)
  })

  it('finishes a mixed group without borrowing progress from waiting tools or the model', async () => {
    const first = readTool('one', 'running')
    const second = readTool('two', 'completed')
    const { root, turn } = mountTurn([{ id: 'thought', contentIndex: 0, kind: 'reasoning', status: 'completed', text: 'Checking output' }, first, second])
    expect(root.querySelector('.buddy-chat-run-activity')).not.toBeNull()
    const header = root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!
    expect(header.textContent?.trim()).toBe('思考 · 读取 1 个文件')
    expect(header.getAttribute('aria-label')).toContain('运行中')
    expect(header.querySelector('.buddy-chat-activity-spinner')).not.toBeNull()
    header.click()
    await nextTick()
    expect(header.querySelector('.buddy-chat-activity-spinner')).toBeNull()
    expect(header.querySelector('.buddy-shimmer-text--continuous')).not.toBeNull()
    expect(root.querySelector('[data-tool-call-id="one"] .buddy-chat-activity-spinner')).not.toBeNull()
    turn.value = { ...turn.value, nodes: [turn.value.nodes[0]!, { ...first, status: 'completed' }, second], progress: { phase: 'model_requesting', toolName: null } }
    await nextTick()
    expect(header.textContent?.trim()).toBe('思考 · 读取 1 个文件')
    expect(root.querySelector('.buddy-chat-activity-group.is-active')).toBeNull()
    expect(root.querySelector('.buddy-chat-run-activity .buddy-chat-activity-status__label')?.textContent).toContain('等待模型响应')
    expect(header.getAttribute('aria-expanded')).toBe('true')
    turn.value = { ...turn.value, nodes: [...turn.value.nodes, readTool('three', 'awaiting_approval')], progress: { phase: 'awaiting_approval', toolName: 'read' } }
    await nextTick()
    expect(root.querySelector('.buddy-chat-run-activity')).not.toBeNull()
    expect(root.querySelector('.buddy-chat-tool.is-awaiting_approval')?.textContent).toContain('等待批准')
    expect(root.querySelector('.buddy-chat-activity-group .buddy-chat-activity-spinner')).toBeNull()
    header.click()
    await nextTick()
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.querySelector('.buddy-chat-activity-spinner')).toBeNull()
    expect(header.querySelector('.buddy-shimmer-text--continuous')).toBeNull()
  })

  it('mounts expensive details only on request, keeps manual state through completion and group collapse', async () => {
    const node = readTool('one', 'running')
    const { root, turn } = mountTurn([{ id: 'thought', contentIndex: 0, kind: 'reasoning', status: 'completed', text: '**A thought**' }, node])
    const group = () => root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!
    expect(root.querySelector('.buddy-chat-tool')).toBeNull()
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBeNull()
    group().click()
    await nextTick()
    expect(root.querySelector('.buddy-chat-tool-details')).toBeNull()
    root.querySelector<HTMLButtonElement>('.buddy-chat-tool__header')!.click()
    await nextTick()
    const toolElement = root.querySelector('.buddy-chat-tool')
    const details = root.querySelector('.buddy-chat-tool-details')
    expect(details?.textContent).toContain('x'.repeat(100))
    turn.value = { ...turn.value, completedAt: '2026-09-09T00:00:10Z', status: 'completed', nodes: [turn.value.nodes[0]!, { ...node, status: 'completed' }] }
    await nextTick()
    expect(root.querySelector('.buddy-chat-tool')).toBe(toolElement)
    expect(root.querySelector('.buddy-chat-tool-details')).toBe(details)
    expect(group().getAttribute('aria-expanded')).toBe('true')
    group().click()
    await nextTick()
    await vi.waitFor(() => expect(root.querySelector('.buddy-chat-tool-details')).toBeNull())
    group().click()
    await nextTick()
    expect(root.querySelector('.buddy-chat-tool__header')?.getAttribute('aria-expanded')).toBe('true')
    expect(root.querySelector('.buddy-chat-tool-details')).not.toBeNull()
  })

  it('retains one open reasoning row while adjacent blocks stream, settle and are followed by tools', async () => {
    const title = 'Investigating image upload naming'
    const thought: ChatAgentTurnNode = { id: 'thought', contentIndex: 0, kind: 'reasoning', status: 'completed', text: `**${title}**` }
    const { root, turn } = mountTurn([thought])
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBeNull()
    root.querySelector<HTMLButtonElement>('.buddy-chat-reasoning-entry__header')!.click()
    await nextTick()
    const body = root.querySelector('.buddy-chat-reasoning-entry__body')
    expect(root.querySelector('.buddy-chat-activity-group__header')).toBeNull()
    expect(root.querySelector('.buddy-chat-reasoning-entry__label')?.textContent).toBe('思考')
    expect(root.textContent?.split(title)).toHaveLength(2)
    expect(body?.textContent?.trim()).toBe(title)
    const following: ChatAgentTurnNode = { ...thought, id: 'following', contentIndex: 1, status: 'running', text: 'Check the extension' }
    turn.value = { ...turn.value, nodes: [thought, following] }
    await nextTick()
    expect(root.querySelector('.buddy-chat-activity-group__header')).toBeNull()
    expect(root.querySelectorAll('.buddy-chat-reasoning-entry__header')).toHaveLength(1)
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBe(body)
    expect(body?.textContent).toContain('Check the extension')
    expect(root.querySelector('.buddy-chat-reasoning-entry__header .buddy-chat-activity-spinner')).not.toBeNull()
    const settled: ChatAgentTurnNode[] = [thought, { ...following, status: 'completed', text: 'Check the extension and format' }]
    turn.value = { ...turn.value, nodes: settled }
    await nextTick()
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBe(body)
    expect(body?.textContent).toContain('Check the extension and format')
    expect(root.querySelector('.buddy-chat-reasoning-entry__header .buddy-chat-activity-spinner')).toBeNull()
    turn.value = { ...turn.value, nodes: [...settled, readTool('one', 'running')] }
    await nextTick()
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBe(body)
    expect(root.textContent?.split(title)).toHaveLength(2)
    expect(root.querySelector('.buddy-chat-tool-details')).toBeNull()
  })

  it('keeps a manually closed reasoning row closed as more blocks arrive and interruption settles it', async () => {
    const thought: ChatAgentTurnNode = { id: 'thought', contentIndex: 0, kind: 'reasoning', status: 'completed', text: 'First thought' }
    const { root, turn } = mountTurn([thought])
    const header = root.querySelector<HTMLButtonElement>('.buddy-chat-reasoning-entry__header')!
    header.click()
    await nextTick()
    header.click()
    await nextTick()
    const following: ChatAgentTurnNode[] = Array.from({ length: 9 }, (_, index) => ({ ...thought, id: `following:${index}`, contentIndex: index + 1, text: `Thought ${index}` }))
    turn.value = { ...turn.value, nodes: [thought, ...following, { ...thought, id: 'active', contentIndex: 10, status: 'running', text: '' }] }
    await nextTick()
    expect(root.querySelector('.buddy-chat-reasoning-entry__header')).toBe(header)
    expect(root.querySelectorAll('.buddy-chat-reasoning-entry__header')).toHaveLength(1)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.textContent).toContain('正在思考')
    expect(root.querySelector('.buddy-chat-activity-group__header')).toBeNull()
    expect(root.querySelector('.buddy-chat-activity-group__collapse')).toBeNull()
    turn.value = { ...turn.value, status: 'cancelled', nodes: [thought, ...following, { ...thought, id: 'active', contentIndex: 10, status: 'interrupted', text: 'Partial thought' }] }
    await nextTick()
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.textContent).toContain('已中断')
    await vi.waitFor(() => expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBeNull())
    header.click()
    await nextTick()
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')?.textContent).toContain('Partial thought')
  })

  it.each(['reasoning', 'tool'] as const)('preserves a manually closed %s when the next tool forms a group', async (kind) => {
    const node: ChatAgentTurnNode = kind === 'reasoning'
      ? { id: 'thought', contentIndex: 0, kind, status: 'running', text: 'Checking the layout' }
      : readTool('one', 'running')
    const { root, turn } = mountTurn([node])
    const header = root.querySelector<HTMLButtonElement>(kind === 'reasoning' ? '.buddy-chat-reasoning-entry__header' : '.buddy-chat-tool__header')!
    header.click()
    await nextTick()
    header.click()
    await nextTick()
    expect(header.getAttribute('aria-expanded')).toBe('false')
    turn.value = { ...turn.value, nodes: [node, readTool('next', 'running')] }
    await nextTick()
    expect(root.querySelector('.buddy-chat-activity-group__header')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('discloses long untitled thoughts independently and retains the reader choice through group changes', async () => {
    const text = `The beginning\n\n${'Reasoning detail. '.repeat(5_000)}\n\nThe end`
    const thought: ChatAgentTurnNode = { id: 'long-thought', contentIndex: 0, kind: 'reasoning', status: 'completed', text }
    const interrupted: ChatAgentTurnNode = { id: 'interrupted-thought', contentIndex: 0, kind: 'reasoning', status: 'interrupted', text: 'Partial reasoning' }
    const { root, turn } = mountTurn([thought, readTool('one', 'completed'), interrupted], 'completed')
    const group = root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!
    group.click()
    await nextTick()
    const headings = () => [...root.querySelectorAll<HTMLButtonElement>('.buddy-chat-reasoning-entry__header')]
    expect(headings().map(header => header.textContent)).toEqual(['思考', '思考已中断'])
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBeNull()
    headings()[0]!.click()
    await nextTick()
    const body = root.querySelector('.buddy-chat-reasoning-entry__body')!
    expect(body.textContent?.startsWith('The beginning')).toBe(true)
    expect(body.textContent?.trimEnd().endsWith('The end')).toBe(true)
    expect(body.textContent?.match(/Reasoning detail\./g)).toHaveLength(5_000)
    group.click()
    await nextTick()
    await vi.waitFor(() => expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBeNull())
    group.click()
    await nextTick()
    expect(headings().map(header => header.getAttribute('aria-expanded'))).toEqual(['true', 'false'])
    headings()[0]!.scrollIntoView = () => {}
    root.querySelector<HTMLButtonElement>('.buddy-chat-reasoning-entry__collapse')!.click()
    await nextTick()
    expect(document.activeElement).toBe(headings()[0])
    turn.value = { ...turn.value, nodes: [...turn.value.nodes, readTool('two', 'completed')] }
    await nextTick()
    expect(headings().map(header => header.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
    await vi.waitFor(() => expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBeNull())
  })

  it('renders process narration as safe Markdown', () => {
    const text = [
      '**Review complete** with `inline code`.',
      '',
      '- First finding',
      '- Second finding',
      '',
      '```ts',
      'const healthy = true',
      '```',
      '',
      '<img src="https://example.com/tracker.png">',
    ].join('\n')
    const { root } = mountTurn([{ id: 'narration', kind: 'text', messageId: 'narration', text }], 'completed')
    const body = root.querySelector('.buddy-chat-narration-body')!

    expect(body.querySelector('strong')?.textContent).toBe('Review complete')
    expect(body.querySelector(':not(pre) > code')?.textContent).toBe('inline code')
    expect([...body.querySelectorAll('li')].map(item => item.textContent)).toEqual(['First finding', 'Second finding'])
    expect(body.querySelector('pre code')?.textContent).toContain('const healthy = true')
    expect(body.querySelector('img')).toBeNull()
    expect(body.textContent).toContain('<img src="https://example.com/tracker.png">')
  })

  it('shows a single finished tool directly and retains its open output when a group forms', async () => {
    const node = readTool('one', 'completed')
    const { root, turn } = mountTurn([node], 'completed')
    expect(root.querySelectorAll('button[aria-expanded]')).toHaveLength(1)
    root.querySelector<HTMLButtonElement>('.buddy-chat-tool__header')!.click()
    await nextTick()
    const tool = root.querySelector('.buddy-chat-tool')
    const details = root.querySelector('.buddy-chat-tool-details')
    expect(details).not.toBeNull()
    turn.value = { ...turn.value, nodes: [node, readTool('two', 'completed')] }
    await nextTick()
    expect(root.querySelector('.buddy-chat-activity-group__header')?.getAttribute('aria-expanded')).toBe('true')
    expect(root.querySelector('.buddy-chat-tool')).toBe(tool)
    expect(root.querySelector('.buddy-chat-tool-details')).toBe(details)
    expect(root.querySelectorAll('.buddy-chat-tool-details')).toHaveLength(1)
  })

  it('compacts consecutive reads while retaining each call, keyboard labels and open output', async () => {
    const nodes = [readTool('one', 'completed'), readTool('two', 'completed'), readTool('three', 'awaiting_approval')]
    const { root, turn } = mountTurn(nodes)
    root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!.click()
    await nextTick()
    const first = root.querySelector('[data-tool-call-id="one"]')!
    const second = root.querySelector('[data-tool-call-id="two"]')!
    expect(root.querySelectorAll('.is-compact-continuation')).toHaveLength(1)
    expect(second.querySelector('button')?.getAttribute('aria-label')).toContain('读取文件 · src/Row.vue')
    second.querySelector('button')!.click()
    await nextTick()
    const output = root.querySelector('[data-tool-detail-id="two"]')
    expect(output).not.toBeNull()
    expect(root.querySelectorAll('.is-compact-continuation')).toHaveLength(1)
    expect(second.compareDocumentPosition(output!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    turn.value = { ...turn.value, nodes: [...nodes, readTool('four', 'completed')] }
    await nextTick()
    expect(root.querySelector('[data-tool-call-id="one"]')).toBe(first)
    expect(root.querySelector('[data-tool-call-id="two"]')).toBe(second)
    expect(root.querySelector('[data-tool-detail-id="two"]')).toBe(output)
    expect(root.querySelector('[data-tool-call-id="three"]')?.classList.contains('is-awaiting_approval')).toBe(true)
  })

  it('cycles issues from a collapsed group and focuses denied tools even when no details are available', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })
    cleanups.push(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    })
    const { root } = mountTurn([readTool('failed', 'failed'), readTool('ok', 'completed'), readTool('denied', 'denied')])
    const issue = root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__issues')!
    expect(issue.textContent).toContain('2 项异常')
    expect(root.querySelector('.buddy-chat-tool-details')).toBeNull()
    issue.click()
    await nextTick()
    await nextTick()
    expect(root.querySelector('.buddy-chat-activity-group__header')?.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(root.querySelector('[data-tool-call-id="failed"] button'))
    const details = root.querySelector('[data-tool-detail-id="failed"]')
    expect(details?.textContent).toContain('x'.repeat(100))
    expect(details?.querySelector('.buddy-chat-tool-read__numbers')).toBeNull()
    issue.click()
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(root.querySelector('[data-tool-call-id="denied"]'))
    expect(root.querySelector('[data-tool-detail-id="denied"]')).toBeNull()
    expect(root.querySelector('.is-highlighted')?.getAttribute('data-tool-call-id')).toBe('denied')
    issue.click()
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(root.querySelector('[data-tool-call-id="failed"] button'))
    expect(root.querySelector('[data-tool-detail-id="failed"]')).toBe(details)
    expect(root.querySelector('button button')).toBeNull()
  })

  it('keeps hundreds of historical headers and an open read stable through streaming and completion', async () => {
    const history = Array.from({ length: 500 }, (_, index) => readTool(`history-${index}`, 'completed'))
    const current = readTool('stream', 'running')
    const { root, turn } = mountTurn([...history, current])
    root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!.click()
    await nextTick()
    expect(root.querySelector('.buddy-chat-tool-details')).toBeNull()
    const headers = [...root.querySelectorAll<HTMLButtonElement>('.buddy-chat-tool__header')]
    headers[250]!.click()
    await nextTick()
    const details = root.querySelector('[data-tool-detail-id="history-250"]')
    expect(details?.querySelectorAll('pre')).toHaveLength(2)
    for (let index = 0; index < 10; index++) {
      turn.value = { ...turn.value, nodes: [...history, { ...current, presentation: { ...current.presentation, output: `delta-${index}` } }] }
      await nextTick()
      expect([...root.querySelectorAll('.buddy-chat-tool__header')]).toEqual(headers)
      expect(root.querySelectorAll('.buddy-chat-tool-details')).toHaveLength(1)
      expect(root.querySelector('[data-tool-detail-id="history-250"]')).toBe(details)
    }
    turn.value = { ...turn.value, nodes: [...history, { ...current, status: 'completed' }] }
    await nextTick()
    expect([...root.querySelectorAll('.buddy-chat-tool__header')]).toEqual(headers)
    expect(root.querySelector('[data-tool-detail-id="history-250"]')).toBe(details)
    expect(root.querySelectorAll('.is-compact-continuation')).toHaveLength(500)
  })

  it('collapses a long group from its footer and returns keyboard focus to its header', async () => {
    const { root } = mountTurn(Array.from({ length: 12 }, (_, index) => readTool(String(index), 'completed')))
    const header = root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!
    header.scrollIntoView = () => {}
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
  it('keeps per-tool loading feedback when a preparing call becomes an expanded parallel group', async () => {
    const preparing = readTool('first', 'preparing')
    const parallel = readTool('second', 'running')
    const pending = readTool('pending', 'awaiting_approval')
    const failed = readTool('failed', 'failed')
    const { root, turn } = mountTurn([preparing])
    const first = root.querySelector('[data-tool-call-id="first"]')!
    const icon = first.querySelector('.buddy-chat-activity-row__icon')
    expect(first.querySelector('.buddy-chat-tool__status')?.textContent).toContain('准备')
    expect(first.querySelector('.buddy-chat-tool__status .buddy-chat-activity-spinner')).not.toBeNull()
    first.querySelector<HTMLButtonElement>('.buddy-chat-tool__header')!.click()
    await nextTick()
    turn.value = { ...turn.value, nodes: [{ ...preparing, status: 'running' }, parallel, pending, failed] }
    await nextTick()
    const content = root.querySelector('.buddy-chat-activity-group__content')!
    expect(first.querySelector('.buddy-chat-activity-row__icon')).toBe(icon)
    expect(first.querySelector('.buddy-chat-tool__status')?.textContent).toContain('运行中')
    expect(first.querySelector('.buddy-chat-tool__status .buddy-chat-activity-spinner')).not.toBeNull()
    expect(content.querySelector('[data-tool-call-id="second"] .buddy-chat-activity-spinner')).not.toBeNull()
    expect(content.querySelector('[data-tool-call-id="pending"] .buddy-chat-tool__status')?.textContent).toContain('等待批准')
    expect(content.querySelector('[data-tool-call-id="pending"] .buddy-chat-activity-spinner')).toBeNull()
    expect(content.querySelector('[data-tool-call-id="failed"] .buddy-chat-activity-spinner')).toBeNull()
    expect(content.querySelectorAll('.buddy-chat-activity-spinner')).toHaveLength(2)
    expect(content.querySelector('.buddy-shimmer-text--continuous')).toBeNull()
    turn.value = { ...turn.value, nodes: [{ ...preparing, status: 'completed' }, { ...parallel, status: 'cancelled' }, pending, failed] }
    await nextTick()
    expect(content.querySelector('.buddy-chat-activity-spinner')).toBeNull()
    expect(first.querySelector('.buddy-chat-activity-row__icon')).toBe(icon)
  })

  it('keeps the accumulated header and open output while reasoning starts and finishes', async () => {
    const history = [readTool('one', 'completed'), readTool('two', 'completed')]
    const { root, turn } = mountTurn(history)
    const group = root.querySelector<HTMLButtonElement>('.buddy-chat-activity-group__header')!
    const icon = group.querySelector('.buddy-chat-activity-row__icon')
    expect(icon).not.toBeNull()
    group.click()
    await nextTick()
    root.querySelector<HTMLButtonElement>('.buddy-chat-tool__header')!.click()
    await nextTick()
    const output = root.querySelector('.buddy-chat-tool-details')
    const thought: ChatAgentTurnNode = { id: 'new-thought', kind: 'reasoning', contentIndex: 0, status: 'running', text: '**Reviewing the results**' }
    turn.value = { ...turn.value, nodes: [...history, thought] }
    await nextTick()
    expect(group.textContent).toContain('思考 · 读取 1 个文件')
    expect(group.querySelector('.buddy-chat-activity-row__icon')).toBe(icon)
    expect(group.querySelector('.buddy-shimmer-text--continuous')).not.toBeNull()
    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(root.querySelector('.buddy-chat-tool-details')).toBe(output)
    expect(root.querySelector('.buddy-chat-activity-group .buddy-chat-reasoning-entry__body')).toBeNull()
    const status = root.querySelector('.buddy-chat-run-activity')!
    expect(status.textContent).toContain('正在思考')
    expect(status.textContent).not.toContain('Reviewing the results')
    expect(root.querySelector('.buddy-chat-reasoning-entry__header .buddy-chat-activity-spinner')).not.toBeNull()
    root.querySelector<HTMLButtonElement>('.buddy-chat-reasoning-entry__header')!.click()
    await nextTick()
    const body = root.querySelector('.buddy-chat-reasoning-entry__body')
    expect(body?.textContent).toContain('Reviewing the results')
    expect(root.querySelectorAll('.buddy-chat-reasoning-entry__body')).toHaveLength(1)
    turn.value = { ...turn.value, nodes: [...history, { ...thought, status: 'completed' }], progress: { phase: 'model_responding', toolName: null } }
    await nextTick()
    expect(status.textContent).toContain('正在回复')
    expect(group.textContent?.trim()).toBe('思考 · 读取 1 个文件')
    expect(group.querySelector('.buddy-chat-activity-row__icon')).toBe(icon)
    expect(group.querySelector('.buddy-shimmer-text--continuous')).toBeNull()
    expect(root.querySelector('.buddy-chat-reasoning-entry__header .buddy-chat-activity-spinner')).toBeNull()
    expect(root.querySelector('.buddy-chat-tool-details')).toBe(output)
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBe(body)
  })

  it('shows real empty thinking without empty details and retains the open body through interruption and grouping', async () => {
    const thought: ChatAgentTurnNode = { id: 'thought', kind: 'reasoning', contentIndex: 0, status: 'running', text: '' }
    const { root, turn } = mountTurn([thought])
    const header = root.querySelector<HTMLButtonElement>('.buddy-chat-reasoning-entry__header')!
    expect(header.disabled).toBe(true)
    expect(header.textContent).toBe('正在思考')
    expect(header.querySelector('.buddy-chat-activity-spinner')).not.toBeNull()
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBeNull()
    turn.value = { ...turn.value, nodes: [{ ...thought, text: 'Checking the layout' }] }
    await nextTick()
    expect(header.disabled).toBe(false)
    header.click()
    await nextTick()
    const body = root.querySelector('.buddy-chat-reasoning-entry__body')
    expect(body?.textContent).toContain('Checking the layout')
    turn.value = { ...turn.value, nodes: [{ ...thought, text: 'Checking the layout\n\nMore detail' }, readTool('one', 'running')] }
    await nextTick()
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBe(body)
    expect(body?.textContent).toContain('More detail')
    expect(root.querySelector('.buddy-chat-activity-group__header')?.getAttribute('aria-expanded')).toBe('true')
    turn.value = { ...turn.value, status: 'cancelled', nodes: [{ ...thought, status: 'interrupted', text: 'Checking the layout\n\nMore detail' }, readTool('one', 'cancelled')] }
    await nextTick()
    expect(root.querySelector('.buddy-chat-reasoning-entry__body')).toBe(body)
    expect(header.textContent).toBe('思考已中断')
    expect(header.querySelector('.buddy-chat-activity-spinner')).toBeNull()
    expect(root.querySelector('.buddy-chat-run-activity')).toBeNull()
  })

  it('keeps compaction boundaries and changes its current state into a quiet history record', async () => {
    const history = [readTool('one', 'completed'), readTool('two', 'completed')]
    const { root, turn } = mountTurn(history)
    const group = root.querySelector('.buddy-chat-activity-group')
    const status = root.querySelector('.buddy-chat-run-activity')
    const compaction: ChatAgentTurnNode = { id: 'compact', kind: 'compaction', status: 'running', tokensBefore: null, estimatedTokensAfter: null }
    turn.value = { ...turn.value, nodes: [...history, compaction] }
    await nextTick()
    expect(root.querySelector('.buddy-chat-compaction')).toBeNull()
    expect(root.querySelector('.buddy-chat-run-activity')).toBe(status)
    expect(status?.textContent).toContain('正在整理上下文')
    expect(root.querySelectorAll('.buddy-chat-activity-loader')).toHaveLength(1)
    expect(status?.querySelector('.buddy-chat-run-activity__duration')).not.toBeNull()
    turn.value = { ...turn.value, nodes: [...history, { ...compaction, status: 'completed', tokensBefore: 4000, estimatedTokensAfter: 2000 }, readTool('after', 'completed')], progress: { phase: 'model_requesting', toolName: null } }
    await nextTick()
    expect(root.querySelector('.buddy-chat-activity-group')).toBe(group)
    expect(root.querySelectorAll('.buddy-chat-activity-group')).toHaveLength(2)
    expect(root.querySelector('.buddy-chat-compaction')?.textContent).toContain('上下文已整理')
    expect(root.querySelector('.buddy-chat-compaction')?.textContent).toContain('4,000 → 2,000 tokens')
    expect(root.querySelector('.buddy-chat-compaction .buddy-shimmer-text--continuous')).toBeNull()
    expect(status?.textContent).toContain('等待模型响应')
  })

  it('keeps execution, pending approval and issues visible together without animating waiting groups', async () => {
    const running = readTool('running', 'running')
    const pending = readTool('approval', 'awaiting_approval')
    const { root, turn, stopping } = mountTurn([readTool('failed', 'failed'), running, pending, { id: 'narration', kind: 'text', messageId: 'narration', text: 'Another stage' }, readTool('history-2', 'completed'), readTool('approval-2', 'awaiting_approval')])
    const status = root.querySelector('.buddy-chat-run-activity')!
    const groups = [...root.querySelectorAll('.buddy-chat-activity-group')]
    expect(groups[0]?.getAttribute('data-status')).toBe('running')
    expect(groups[0]?.querySelector('.buddy-chat-activity-group__approval')?.textContent).toContain('1 项待批准')
    expect(groups[0]?.querySelector('.buddy-chat-activity-group__issues')?.textContent).toContain('1 项异常')
    expect(groups[0]?.querySelector('.buddy-shimmer-text--continuous')).not.toBeNull()
    expect(groups[0]?.querySelector('.buddy-chat-activity-group__header .buddy-chat-activity-spinner')).not.toBeNull()
    expect(groups[1]?.getAttribute('data-status')).toBe('awaiting_approval')
    expect(groups[1]?.querySelector('.buddy-shimmer-text--continuous')).toBeNull()
    expect(groups[1]?.querySelector('.buddy-chat-activity-spinner')).toBeNull()
    expect(status.textContent).toContain('有操作待批准')
    expect(status.querySelector('.buddy-chat-activity-loader')).toBeNull()
    stopping.value = true
    await nextTick()
    expect(status.textContent).toContain('正在停止')
    expect(groups[0]?.getAttribute('data-status')).toBe('running')
    stopping.value = false
    turn.value = { ...turn.value, nodes: [running, { ...pending, status: 'completed' }] }
    await nextTick()
    expect(status.textContent).toContain('正在执行')
    expect(status.textContent).not.toContain('待批准')
  })
})

function mountTurn(nodes: ChatAgentTurnNode[], status: ChatAgentTurn['status'] = 'running') {
  const turn = shallowRef<ChatAgentTurn>({ branchId: 'branch', runId: 'run', completedAt: null, finalMessageId: null, nodes, processMessageIds: [], progress: null, reasoningLevel: null, startedAt: '2026-09-09T00:00:00Z', status, triggeringMessageId: 'question', usage: null })
  const stopping = shallowRef(false)
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    setup: () => {
      useProvideDesktopUi({
        language: shallowRef('zh-CN'),
        isDark: shallowRef(false),
        appSidebarCollapsed: shallowRef(false),
        chat: shallowRef({ outlinePosition: 'top-right', pasteTextAsAttachment: true, permissionMode: 'policy_approval', welcome: 'random' }),
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
  return { id: `tool:${id}`, toolCallId: id, toolName: 'read', kind: 'tool', status, isError: false, description: null, presentation: { card: 'read', path: 'src/Row.vue', lineStart: 1, language: 'vue', description: null, output: 'x'.repeat(64 * 1024), truncated: false } }
}
