import type { ChatAgentToolNode, ChatAgentTurn, ChatAgentTurnNode } from '../chatAgentTurn'
import { describe, expect, it } from 'vitest'
import { describeChatCompaction } from '../chatCompactionDisplay'
import { describeChatCurrentActivity } from '../chatCurrentActivity'

const thought: ChatAgentTurnNode = { id: 'reasoning', kind: 'reasoning', contentIndex: 0, status: 'running', text: '**Reviewing the implementation**\n\nDetails' }
const compaction = { id: 'compaction', kind: 'compaction', status: 'running', tokensBefore: null, estimatedTokensAfter: null } as const
function tool(id: string, status: ChatAgentToolNode['status']): ChatAgentToolNode {
  return { id, kind: 'tool', status, toolCallId: id, toolName: 'bash', description: null, isError: false, presentation: { card: 'terminal', command: 'pnpm test > output.log 2>&1; result=$?; tail -12 output.log', cwd: '.', description: null, output: null, exitCode: null, signal: null, truncated: false } }
}
function turn(nodes: ChatAgentTurnNode[], phase: NonNullable<ChatAgentTurn['progress']>['phase'] = 'model_requesting'): ChatAgentTurn {
  return { nodes, branchId: 'branch', runId: 'run', completedAt: null, finalMessageId: null, processMessageIds: [], progress: { phase, toolName: null }, reasoningLevel: null, startedAt: '2026-09-10T00:00:00Z', status: 'running', triggeringMessageId: 'question', usage: null }
}

describe('current execution status', () => {
  it('keeps local details in their groups and gives approval priority during parallel execution', () => {
    const running = [tool('one', 'running'), tool('two', 'running')]
    const preparing = tool('three', 'preparing')
    const approval = tool('four', 'awaiting_approval')
    expect(describeChatCurrentActivity(turn([...running, preparing, approval, thought]), 'zh-CN')).toEqual({ label: '有操作待批准', active: false, warning: true })
    expect(describeChatCurrentActivity(turn([...running, preparing]), 'zh-CN')).toEqual({ label: '正在执行', active: true })
    expect(describeChatCurrentActivity(turn([preparing]), 'zh-CN')).toEqual({ label: '准备中', active: true })
    expect(describeChatCurrentActivity(turn(running), 'en-US')).toEqual({ label: 'Running', active: true })
  })

  it('moves between reasoning, compaction and model progress using the current event state', () => {
    expect(describeChatCurrentActivity(turn([tool('done', 'completed'), thought]), 'zh-CN')).toEqual({ label: '正在思考', active: true })
    expect(describeChatCurrentActivity(turn([thought, compaction]), 'zh-CN')).toEqual({ label: '正在整理上下文', active: true })
    const nodes = [{ ...thought, status: 'completed' } as ChatAgentTurnNode, { ...compaction, status: 'completed' } as ChatAgentTurnNode]
    expect(describeChatCurrentActivity(turn(nodes), 'zh-CN')?.label).toBe('等待模型响应')
    expect(describeChatCurrentActivity(turn(nodes, 'model_streaming'), 'zh-CN')?.label).toBe('正在处理')
    expect(describeChatCurrentActivity(turn(nodes, 'model_responding'), 'zh-CN')?.label).toBe('正在回复')
    expect(describeChatCurrentActivity(turn(nodes, 'tool_executing'), 'zh-CN')?.label).toBe('正在处理')
    expect(describeChatCurrentActivity({ ...turn([thought]), status: 'cancelled' }, 'zh-CN')).toBeNull()
  })
})

describe('waiting and cancellation feedback', () => {
  it('only animates retry requests, not their deadlines, and keeps their budgets', () => {
    const current = turn([])
    const retry = { attempt: 2, maxAttempts: 'unlimited' as const, retryAt: '2026-09-10T00:00:05Z' }
    current.progress = { phase: 'model_requesting', toolName: null, retry }
    expect(describeChatCurrentActivity(current, 'zh-CN', Date.parse('2026-09-10T00:00:03Z'))).toEqual({ label: '2 秒后重试', active: false, warning: true, retry })
    expect(describeChatCurrentActivity(current, 'zh-CN', Date.parse('2026-09-10T00:00:06Z'))?.active).toBe(false)
    current.progress.retry = { ...retry, retryAt: null }
    expect(describeChatCurrentActivity(current, 'zh-CN')).toMatchObject({ label: '正在重试', active: true })
    expect(describeChatCurrentActivity(current, 'zh-CN', Date.now(), true)).toEqual({ label: '正在停止', active: false })
  })

  it('waits to start without inventing a queue and hides feedback only after termination', () => {
    expect(describeChatCurrentActivity({ ...turn([]), status: 'queued' }, 'zh-CN')).toEqual({ label: '等待开始', active: false })
    for (const status of ['completed', 'failed', 'cancelled'] as const)
      expect(describeChatCurrentActivity({ ...turn([thought]), status }, 'zh-CN', Date.now(), true)).toBeNull()
  })
})

describe('compaction display', () => {
  it('only shows token results after success and keeps interrupted and failed states distinct', () => {
    expect(describeChatCompaction(compaction, 'zh-CN')).toMatchObject({ active: true, label: '正在整理上下文', detail: '', warning: false })
    const completed = { ...compaction, status: 'completed', tokensBefore: 2000, estimatedTokensAfter: 0 } as const
    expect(describeChatCompaction(completed, 'zh-CN')).toEqual({ active: false, label: '上下文已整理', detail: '2,000 → 0 tokens', warning: false })
    expect(describeChatCompaction({ ...completed, status: 'failed' }, 'zh-CN')).toMatchObject({ label: '上下文整理失败', detail: '', warning: true })
    expect(describeChatCompaction({ ...completed, status: 'interrupted' }, 'zh-CN')).toMatchObject({ label: '上下文整理已中断', warning: false })
  })
})
