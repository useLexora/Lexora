import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import { describe, expect, it } from 'vitest'
import { executionPhaseLabel, executionStatus } from '../../../widgets/executions/executionPresentation'
import { executionNeedsAttention, projectExecutionCanvas } from '../executionCanvas'
import { projectExecutionGroups, projectTaskPartners } from '../executionGroups'

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
  it('distinguishes public actor collaboration from private subtask work using execution kinds', () => {
    const records = [root(), execution('npc'), execution('actor', { kind: 'actor_child', ordinal: 2 }), execution('actor-again', { kind: 'actor_child', buddyId: 'actor', ordinal: 3, phase: 'closed', status: 'completed' })]
    const group = projectExecutionGroups(records).byRoot.get('root')!
    expect(group.mode).toBe('collaboration')
    expect(group.participantCount).toBe(1)
    expect(group.actors.map(actor => actor.runId)).toEqual(['root', 'actor', 'actor-again'])
    expect(group.activeActors.map(actor => actor.runId)).toEqual(['root', 'actor'])
    expect(group.subtasks.map(child => child.runId)).toEqual(['npc'])
    expect(projectExecutionGroups(records.slice(0, 2)).byRoot.get('root')?.mode).toBe('subtasks')
    expect(projectExecutionGroups([root()]).byRoot.get('root')?.mode).toBe('single')
  })

  it('counts active partners once through waiting and stopping, excluding the actual lead actor and NPCs', () => {
    const records = [root(), execution('first', { kind: 'actor_child', buddyId: 'partner', waitingFor: 'approval' }), execution('second', { kind: 'actor_child', buddyId: 'partner', waitingFor: 'answer' }), execution('third', { kind: 'actor_child', buddyId: 'other', stopping: true, phase: 'closing' }), execution('self', { kind: 'actor_child', buddyId: 'root' }), execution('npc')]
    expect(projectTaskPartners(projectExecutionGroups(records)).activeCount).toBe(2)
    records[1] = { ...records[1]!, phase: 'closed', status: 'cancelled' }
    expect(projectTaskPartners(projectExecutionGroups(records)).activeCount).toBe(2)
    records[2] = { ...records[2]!, phase: 'closed', status: 'completed' }
    expect(projectTaskPartners(projectExecutionGroups(records)).activeCount).toBe(1)
    records[3] = { ...records[3]!, phase: 'closed', status: 'cancelled' }
    expect(projectTaskPartners(projectExecutionGroups(records)).activeCount).toBe(0)
    const next = execution('next', { rootRunId: 'next', kind: 'root', parentRunId: null, startedAt: '2026-10-13T00:00:00.000Z' })
    expect([...projectTaskPartners(projectExecutionGroups([...records, next])).byBuddy.keys()]).toEqual(['next'])
  })

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
