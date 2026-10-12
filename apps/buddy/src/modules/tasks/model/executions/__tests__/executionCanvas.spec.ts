import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import { describe, expect, it } from 'vitest'
import { executionPhaseLabel, executionStatus } from '../../../widgets/executions/executionPresentation'
import { executionNeedsAttention, projectExecutionCanvas } from '../executionCanvas'

function execution(runId: string, overrides: Partial<LocalExecution> = {}): LocalExecution {
  return {
    runId,
    rootRunId: 'root',
    parentRunId: 'root',
    buddyId: runId,
    buddyName: runId,
    ordinal: 1,
    toolCount: 0,
    kind: 'npc_child',
    phase: 'working',
    status: 'running',
    startedAt: '2026-10-12T00:00:00.000Z',
    completedAt: null,
    updatedAt: '2026-10-12T00:00:00.000Z',
    progress: null,
    stopping: false,
    task: 'Inspect a fixture',
    waitingFor: null,
    activeChildren: 0,
    canCancel: true,
    canAnswer: true,
    canSend: true,
    cleanup: 'pending',
    errorCode: null,
    affectedResources: [],
    questions: [],
    ...overrides,
  }
}
const root = () => execution('root', { kind: 'root', parentRunId: null, ordinal: null })
const question = { questionId: 'question', text: 'Choose a color', audience: 'user' as const, open: true, answered: false }

describe('execution canvas projection', () => {
  it('retains the true nested call tree and terminal nodes while excluding other roots and maintenance', () => {
    const records = [
      execution('sibling', { ordinal: 3, status: 'completed', phase: 'closed', startedAt: '2026-10-12T00:00:01.000Z' }),
      execution('nested', { ordinal: 2, parentRunId: 'child', kind: 'actor_child' }),
      execution('foreign', { rootRunId: 'other' }),
      execution('maintenance', { kind: 'maintenance' }),
      execution('orphan', { parentRunId: 'missing' }),
      execution('child'),
      root(),
    ]
    const nodes = projectExecutionCanvas(records, 'root')
    expect(nodes.map(node => [node.execution.runId, node.parentId])).toEqual([
      ['root', null],
      ['child', 'root'],
      ['nested', 'child'],
      ['sibling', 'root'],
    ])
    const child = nodes[1]!
    const nested = nodes[2]!
    const sibling = nodes[3]!
    expect(nested.x).toBeGreaterThan(child.x + child.width)
    expect(sibling.y).toBeGreaterThanOrEqual(child.y + child.height)
    expect(projectExecutionCanvas(records, 'missing')).toEqual([])
  })

  it('keeps geometry and sibling order across state changes and differently ordered snapshots', () => {
    const records = [root(), execution('a'), execution('b', { ordinal: 2 })]
    const geometry = (values: LocalExecution[]) => projectExecutionCanvas(values, 'root').map(({ execution, ...node }) => ({ id: execution.runId, ...node }))
    const before = geometry(records)
    const after = geometry([execution('b', { ordinal: 2, waitingFor: 'answer', questions: [question] }), execution('a', { status: 'failed', phase: 'closed', cleanup: 'degraded' }), root()])
    expect(after).toEqual(before)
  })

  it('only marks actionable user questions and approvals as needing the user', () => {
    expect(executionNeedsAttention(execution('child', { questions: [question] }))).toBe(true)
    expect(executionNeedsAttention(execution('child', { waitingFor: 'approval' }))).toBe(true)
    for (const overrides of [
      { questions: [{ ...question, audience: 'caller' as const }] },
      { questions: [question], canAnswer: false },
      { questions: [question], stopping: true },
      { questions: [question], phase: 'closed' as const, status: 'cancelled' as const },
      { waitingFor: 'children' as const },
      { waitingFor: 'resource' as const },
      { cleanup: 'degraded' as const },
    ]) {
      expect(executionNeedsAttention(execution('child', overrides))).toBe(false)
    }
  })

  it('prioritizes waiting, cancellation and closing over stale tool progress', () => {
    const stale = execution('child', { phase: 'waiting', progress: { phase: 'tool_executing', toolName: 'read' } })
    expect(executionStatus(stale, 'zh-CN')).toBe('等待中')
    expect(executionStatus({ ...stale, waitingFor: 'answer', questions: [question] }, 'zh-CN')).toBe('等待回答')
    expect(executionStatus({ ...stale, stopping: true }, 'zh-CN')).toBe('正在停止')
    expect(executionPhaseLabel({ ...stale, phase: 'closing' }, 'zh-CN')).toBe('正在收尾')
    expect(executionStatus({ ...stale, phase: 'closed', status: 'cancelled' }, 'zh-CN')).toBe('已停止')
  })
})
