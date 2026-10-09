import type { LocalConversationTimelineItem } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { ChatRunStreamingMessage } from '../chatRunStreamingMessages'
import { describe, expect, it } from 'vitest'
import { projectChatAgentTurn } from '../chatAgentTurn'
import { projectChatRunStreamingMessages } from '../chatRunStreamingMessages'
import { createChatTranscriptProjector, projectChatTranscript } from '../chatTranscriptProjection'

const time = (seconds: number) => new Date(Date.UTC(2026, 8, 10, 10, 0, seconds)).toISOString()
const run: LocalRun = {
  id: 'run',
  branchId: 'branch',
  conversationId: 'conversation',
  triggeringMessageId: 'initial',
  status: 'running',
  startedAt: time(0),
  completedAt: null,
  approvalPolicy: 'policy',
  executionProfile: 'workspace_write',
  modelId: 'model',
  providerId: 'provider',
  purpose: 'chat',
  reasoningLevel: null,
  errorCode: null,
}
function message(id: string, role: 'user' | 'assistant', seconds: number): LocalConversationTimelineItem {
  return { kind: 'message', id, role, branchId: run.branchId, conversationId: run.conversationId, runId: role === 'assistant' ? run.id : null, attachments: [], content: { text: id }, createdAt: time(seconds) }
}
function action(seconds: number, overrides: Partial<Extract<LocalConversationTimelineItem, { kind: 'extension-action' }>> = {}): Extract<LocalConversationTimelineItem, { kind: 'extension-action' }> {
  return { kind: 'extension-action', id: `action-${seconds}`, conversationId: run.conversationId, branchId: run.branchId, sourceMessageId: run.triggeringMessageId, extensionId: 'tests.title', extensionName: 'Title', actionId: 'tests.title.generate', title: 'Generate title', trigger: 'task:input:committed', status: 'completed', message: 'Updated', createdAt: time(seconds), completedAt: time(seconds + 1), ...overrides }
}
const eventInputs: Array<[number, string, LocalRunEvent['payload']]> = [
  [1, 'message.completed', { role: 'assistant', messageId: 'before', phase: 'commentary', content: { text: 'before steering' } }],
  [30, 'message.completed', { role: 'assistant', messageId: 'between', phase: 'commentary', content: { text: 'after steering' } }],
  [31, 'message.completed', { role: 'assistant', messageId: 'hello', phase: 'final_answer', content: { text: 'hello' } }],
  [40, 'message.completed', { role: 'assistant', messageId: 'continuation', phase: 'commentary', content: { text: 'continue work' } }],
]
const events: LocalRunEvent[] = eventInputs.map(([seconds, type, payload], index) => ({ runId: run.id, sequence: index + 1, createdAt: time(seconds), type, payload }))
const timelineItems = [message('initial', 'user', 0), message('steer-a', 'user', 10), message('steer-b', 'user', 20), message('hello', 'assistant', 31)]
function input(activeRun = run, eventList = events, items = timelineItems) {
  return { runs: [activeRun], runProjections: [{ turn: projectChatAgentTurn(activeRun, eventList), recoveryNotices: [], streamingMessages: [] as ReadonlyArray<ChatRunStreamingMessage> }], outputs: [], timelineItems: items }
}
function order(projection: ReturnType<typeof projectChatTranscript>) {
  return projection.rows.flatMap(row => row.kind === 'message'
    ? [row.message.id]
    : row.kind === 'agent-turn' ? row.turn.nodes.flatMap(node => node.kind === 'text' ? [node.messageId] : []) : [])
}

describe('interleaved conversation segments', () => {
  it.each([
    { trigger: 'task:input:committed', seconds: 1 },
    { trigger: 'task:input:committed', seconds: 6 },
    { trigger: 'task:turn:completed', seconds: 6 },
    { trigger: 'user', seconds: 6 },
  ] as const)('keeps $trigger actions at $seconds in the originating reply flow during updates and replay', ({ trigger, seconds }) => {
    const completed = { ...run, status: 'completed' as const, completedAt: time(5) }
    const reply: LocalRunEvent = { runId: run.id, sequence: 1, createdAt: time(5), type: 'message.completed', payload: { role: 'assistant', messageId: 'reply', phase: 'final_answer', content: { text: 'Done' } } }
    const messages = [message('initial', 'user', 0), message('reply', 'assistant', 5)]
    const projector = createChatTranscriptProjector()
    for (const status of ['running', 'completed', 'cancelled', 'failed', 'interrupted'] as const) {
      const invocation = action(seconds, { trigger, status, completedAt: status === 'running' ? null : time(seconds + 1) })
      const snapshot = input(completed, [reply], [...messages, invocation])
      const projected = projector.project(snapshot)
      expect(projected.rows).toEqual(projectChatTranscript(snapshot).rows)
      expect(projected.rows.map(row => row.key)).toEqual(['message:initial', 'agent-turn:run', 'message:reply'])
      expect(projected.rows[1]).toMatchObject({ turn: { status: 'completed', nodes: [{ kind: 'tool', invocation }] } })
      expect(projected.rows[2]).toMatchObject({ showIdentity: false, resultRunId: run.id })
    }
    const skipped = input(completed, [reply], [...messages, action(seconds, { trigger, status: 'skipped' })])
    const skippedRows = projector.project(skipped).rows
    if (trigger === 'user')
      expect(skippedRows[1]).toMatchObject({ kind: 'agent-turn', turn: { nodes: [{ invocation: { status: 'skipped' } }] } })
    else
      expect(skippedRows).toEqual(projectChatTranscript(input(completed, [reply], messages)).rows)
  })

  it('keeps an action visible when its source reply is outside the loaded page, then merges it when loaded', () => {
    const completed = { ...run, status: 'completed' as const, completedAt: time(5) }
    const reply: LocalRunEvent = { runId: run.id, sequence: 1, createdAt: time(5), type: 'message.completed', payload: { role: 'assistant', messageId: 'reply', phase: 'final_answer', content: { text: 'Done' } } }
    const invocation = action(6, { trigger: 'task:turn:completed' })
    const page = input(completed, [reply], [message('reply', 'assistant', 5), invocation])
    const projector = createChatTranscriptProjector()
    expect(projector.project(page).rows.at(-1)).toMatchObject({ kind: 'activity-flow', nodes: [{ invocation }] })
    const loaded = { ...page, timelineItems: [message('initial', 'user', 0), ...page.timelineItems] }
    expect(projector.project(loaded).rows.map(row => row.key)).toEqual(['message:initial', 'agent-turn:run', 'message:reply'])
    const unanchored = projectChatTranscript({ ...page, includeUnanchoredTurns: true })
    expect(unanchored.rows.map(row => row.key)).toEqual(['agent-turn:run', 'message:reply'])
    expect(unanchored.rows[0]).toMatchObject({ turn: { nodes: [{ invocation }] } })
  })

  it('associates a delayed action after steering with its reply, keeping later inputs in their own flow', () => {
    const completed = { ...run, status: 'completed' as const, completedAt: time(50) }
    const final: LocalRunEvent = { runId: run.id, sequence: 5, createdAt: time(50), type: 'message.completed', payload: { role: 'assistant', messageId: 'final', phase: 'final_answer', content: { text: 'Done' } } }
    const followup = { ...run, id: 'followup-run', triggeringMessageId: 'followup', startedAt: time(60) }
    const invocation = action(52, { trigger: 'task:turn:completed', sourceMessageId: 'steer-b' })
    const first = input(completed, [...events, final], [...timelineItems, message('final', 'assistant', 50), invocation, message('followup', 'user', 60)])
    const snapshot = { ...first, runs: [completed, followup], runProjections: [...first.runProjections, { turn: projectChatAgentTurn(followup, []), recoveryNotices: [], streamingMessages: [] }] }
    const projector = createChatTranscriptProjector()
    const result = projector.project(snapshot)
    const actionRows = result.rows.filter(row => row.kind === 'agent-turn' && row.turn.nodes.some(node => node.kind === 'tool' && node.invocation))
    expect(actionRows).toHaveLength(1)
    expect(actionRows[0]).toMatchObject({ turn: { runId: run.id, nodes: [{ messageId: 'continuation' }, { invocation }] } })
    expect(result.rows.indexOf(actionRows[0]!)).toBeLessThan(result.rows.findIndex(row => row.key === 'message:final'))
    expect(order(result)).toEqual(['initial', 'before', 'steer-a', 'steer-b', 'between', 'hello', 'continuation', 'final', 'followup'])
    const advanced = { ...snapshot, runProjections: [{ ...snapshot.runProjections[0]!, turn: { ...snapshot.runProjections[0]!.turn } }, snapshot.runProjections[1]!] }
    expect(projector.project(advanced).rows).toEqual(projectChatTranscript(advanced).rows)
  })

  it('does not duplicate earlier actions into a retry of the same input', () => {
    const completed = { ...run, status: 'cancelled' as const, completedAt: time(5) }
    const retry = { ...run, id: 'retry', startedAt: time(10) }
    const first = input(completed, [], [message('initial', 'user', 0), action(6), action(11)])
    const result = projectChatTranscript({ ...first, runs: [completed, retry], runProjections: [...first.runProjections, { turn: projectChatAgentTurn(retry, []), recoveryNotices: [], streamingMessages: [] }] })
    const nodes = result.rows.flatMap(row => row.kind === 'agent-turn' ? row.turn.nodes.flatMap(node => node.kind === 'tool' && node.invocation ? [{ runId: row.turn.runId, actionId: node.invocation.id }] : []) : [])
    expect(nodes).toEqual([{ runId: run.id, actionId: 'action-6' }, { runId: retry.id, actionId: 'action-11' }])
  })

  it('preserves model tool event order when adding plugin actions despite timestamp differences', () => {
    const completed = { ...run, status: 'completed' as const, completedAt: time(10) }
    const presentation = { card: 'generic', argumentNames: [], description: null, output: null, truncated: false }
    const toolEvents: LocalRunEvent[] = [
      { runId: run.id, sequence: 1, createdAt: time(4), type: 'tool.completed', payload: { toolCallId: 'read', toolName: 'read', presentation } },
      { runId: run.id, sequence: 2, createdAt: time(2), type: 'tool.completed', payload: { toolCallId: 'plugin', toolName: 'lexora_plugin_fixture', presentation } },
      { runId: run.id, sequence: 3, createdAt: time(10), type: 'message.completed', payload: { role: 'assistant', messageId: 'reply', phase: 'final_answer', content: { text: 'Done' } } },
    ]
    const original = projectChatAgentTurn(completed, toolEvents)
    const result = projectChatTranscript(input(completed, toolEvents, [message('initial', 'user', 0), message('reply', 'assistant', 10), action(3), action(11)]))
    const nodes = result.rows.flatMap(row => row.kind === 'agent-turn' ? row.turn.nodes : [])
    expect(nodes.map(node => node.id)).toEqual(['extension-action:action-3', 'tool:read', 'tool:plugin', 'extension-action:action-11'])
    expect(nodes.filter(node => node.kind === 'tool' && !node.invocation)).toEqual(original.nodes)
    expect(result.rows.at(-1)?.key).toBe('message:reply')
  })

  it('keeps the avatar before leading actions while the first reply arrives and when it is cancelled', () => {
    const items = [message('initial', 'user', 0), action(1), action(2)]
    const first = input(run, [], items)
    const projector = createChatTranscriptProjector()
    expect(projector.project(first).rows.map(row => row.key)).toEqual(['message:initial', 'agent-turn:run', 'activity:run'])
    const thinking = { ...first, runProjections: [{ ...first.runProjections[0]!, turn: { ...first.runProjections[0]!.turn, nodes: [{ id: 'reasoning', kind: 'reasoning' as const, contentIndex: 0, status: 'running' as const, text: 'Planning' }], nodeStartedAt: { reasoning: time(3) } } }] }
    expect(projector.project(thinking).rows).toEqual(projectChatTranscript(thinking).rows)
    const narration: LocalRunEvent = { runId: run.id, sequence: 1, createdAt: time(3), type: 'message.completed', payload: { role: 'assistant', messageId: 'reply', phase: 'commentary', content: { text: 'Working' } } }
    const next = { ...first, runProjections: input(run, [narration], items).runProjections }
    const active = projector.project(next)
    expect(active.rows).toEqual(projectChatTranscript(next).rows)
    expect(active.rows.map(row => row.key)).toEqual(['message:initial', 'agent-turn:run', 'activity:run'])
    expect(active.rows[1]).toMatchObject({ kind: 'agent-turn', turn: { nodes: [{ id: 'extension-action:action-1' }, { id: 'extension-action:action-2' }, { messageId: 'reply' }] } })
    const ended = projector.project(input({ ...run, status: 'cancelled', completedAt: time(5) }, [narration], items))
    expect(ended.rows.filter(row => row.kind === 'agent-turn' && row.showIdentity !== false).map(row => row.key)).toEqual(['agent-turn:run'])
    expect(ended.rows.at(-1)).toMatchObject({ kind: 'agent-turn', ownsResultActions: true })
  })

  it('retains a single avatar above a leading action for a completed text-only reply', () => {
    const completed = { ...run, status: 'completed' as const, completedAt: time(5) }
    const reply: LocalRunEvent = { runId: run.id, sequence: 1, createdAt: time(5), type: 'message.completed', payload: { role: 'assistant', messageId: 'reply', phase: 'final_answer', content: { text: 'Done' } } }
    const result = projectChatTranscript(input(completed, [reply], [message('initial', 'user', 0), action(1), message('reply', 'assistant', 5)]))
    expect(result.rows.map(row => row.key)).toEqual(['message:initial', 'agent-turn:run', 'message:reply'])
    expect(result.rows.at(-1)).toMatchObject({ showIdentity: false, resultRunId: run.id })
  })

  it('does not associate actions from another branch or input with the reply', () => {
    const completed = { ...run, status: 'completed' as const, completedAt: time(5) }
    const reply: LocalRunEvent = { runId: run.id, sequence: 1, createdAt: time(5), type: 'message.completed', payload: { role: 'assistant', messageId: 'reply', phase: 'final_answer', content: { text: 'Done' } } }
    for (const invocation of [action(1, { branchId: 'another-branch' }), action(6, { sourceMessageId: 'another-input' })]) {
      const result = projectChatTranscript(input(completed, [reply], [message('initial', 'user', 0), invocation, message('reply', 'assistant', 5)]))
      expect(result.rows.filter(row => row.kind === 'agent-turn')).toHaveLength(0)
      expect(result.rows.filter(row => row.kind === 'message').find(row => row.message.id === 'reply')?.showIdentity).not.toBe(false)
      if (invocation.createdAt > reply.createdAt)
        expect(result.rows.at(-1)).toMatchObject({ kind: 'activity-flow' })
    }
  })

  it('groups adjacent independent actions while preserving input boundaries and completed outcomes', () => {
    const completed = { ...run, status: 'cancelled' as const, completedAt: time(5) }
    const result = projectChatTranscript(input(completed, [], [message('initial', 'user', 0), action(6, { sourceMessageId: null }), action(7, { sourceMessageId: null }), message('next', 'user', 8), action(9, { sourceMessageId: 'next' })]))
    expect(result.rows.map(row => row.kind)).toEqual(['message', 'agent-turn', 'activity-flow', 'message', 'activity-flow'])
    expect(result.rows[2]).toMatchObject({ nodes: [{ invocation: { id: 'action-6' } }, { invocation: { id: 'action-7' } }] })
    expect(result.rows[4]).toMatchObject({ nodes: [{ invocation: { sourceMessageId: 'next' } }] })
  })

  it('keeps later activity below an intermediate answer and withholds run result controls while running', () => {
    const projection = projectChatTranscript(input())
    expect(order(projection)).toEqual(['initial', 'before', 'steer-a', 'steer-b', 'between', 'hello', 'continuation'])
    const hello = projection.rows.find(row => row.kind === 'message' && row.message.id === 'hello')
    expect(hello).toMatchObject({ isIntermediate: true, showIdentity: false, turnOutputs: null })
    expect(hello).not.toHaveProperty('resultRunId')
    expect(hello).not.toHaveProperty('turnUsage')
    const segments = projection.rows.filter(row => row.kind === 'agent-turn')
    expect(segments).toHaveLength(3)
    expect(segments[0]).toHaveProperty('showOutcome', false)
    expect(segments[0].showIdentity).not.toBe(false)
    expect(segments[1]).toHaveProperty('showIdentity', false)
    expect(segments[2]).toHaveProperty('showIdentity', false)
  })

  it('keeps the same message and tool order after completion and history replay', () => {
    const active = projectChatTranscript(input())
    const completed: LocalRun = { ...run, status: 'completed', completedAt: time(60) }
    const terminalEvents = [...events, { runId: run.id, sequence: 5, createdAt: time(60), type: 'message.completed', payload: { role: 'assistant', messageId: 'final', phase: 'final_answer', content: { text: 'final' } } }]
    const result = projectChatTranscript(input(completed, terminalEvents, [...timelineItems, message('final', 'assistant', 60)]))
    expect(order(result)).toEqual([...order(active), 'final'])
    expect(result.rows.filter(row => row.kind === 'message' && row.resultRunId).map(row => row.key)).toEqual(['message:final'])
    expect(result.rows.find(row => row.kind === 'message' && row.message.id === 'hello')).toMatchObject({ isIntermediate: true, showIdentity: false })
    expect(result.rows.find(row => row.kind === 'message' && row.message.id === 'final')).toMatchObject({ showIdentity: false, resultRunId: run.id })
    expect(result.rows.find(row => row.kind === 'message' && row.message.id === 'final')).not.toHaveProperty('isIntermediate')
    expect(result.rows.filter(row => row.kind === 'agent-turn').map(row => row.key)).toEqual(active.rows.filter(row => row.kind === 'agent-turn').map(row => row.key))
  })

  it('keeps a reply that began before steering in place when it is saved and replayed', () => {
    const start: LocalRunEvent = { runId: run.id, sequence: 1, createdAt: time(2), type: 'message.started', payload: { role: 'assistant', messageId: 'reply' } }
    const delta: LocalRunEvent = { runId: run.id, sequence: 2, createdAt: time(3), type: 'message.delta', payload: { messageId: 'reply', delta: 'already visible', phase: 'final_answer' } }
    const items = [message('initial', 'user', 0), message('steer-a', 'user', 10)]
    const liveEvents = [start, delta]
    const live = input(run, liveEvents, items)
    live.runProjections[0]!.streamingMessages = projectChatRunStreamingMessages(run, liveEvents)
    const visible = projectChatTranscript(live)
    expect(order(visible)).toEqual(['initial', 'reply', 'steer-a'])
    expect(visible.rows.find(row => row.kind === 'message' && row.message.id === 'reply')).toMatchObject({ isIntermediate: true, showIdentity: false })

    const end: LocalRunEvent = { runId: run.id, sequence: 3, createdAt: time(20), type: 'message.completed', payload: { messageId: 'reply', role: 'assistant', phase: 'final_answer', content: { text: 'already visible and complete' } } }
    const persisted = projectChatTranscript(input(run, [...liveEvents, end], [...items, message('reply', 'assistant', 20)]))
    expect(order(persisted)).toEqual(order(visible))
    const compactedReplay = projectChatTranscript(input(run, [start, end], [...items, message('reply', 'assistant', 20)]))
    expect(order(compactedReplay)).toEqual(order(visible))
  })

  it('starts a new identity for a follow-up run while retaining one identity across steering', () => {
    const followup: LocalRun = { ...run, id: 'followup-run', triggeringMessageId: 'followup', startedAt: time(60) }
    const completed: LocalRun = { ...run, status: 'completed', completedAt: time(50) }
    const first = input(completed)
    const projection = projectChatTranscript({
      ...first,
      runs: [completed, followup],
      timelineItems: [...timelineItems, message('followup', 'user', 60)],
      runProjections: [...first.runProjections, { turn: projectChatAgentTurn(followup, []), recoveryNotices: [], streamingMessages: [] }],
    })
    const identities = projection.rows.flatMap(row => row.kind === 'agent-turn' && row.showIdentity !== false
      ? [row.turn.runId]
      : row.kind === 'message' && row.message.role === 'assistant' && row.showIdentity !== false ? [row.message.runId] : [])
    expect(identities).toEqual([run.id, followup.id])
  })

  it.each(['failed', 'cancelled'] as const)('keeps a single terminal outcome after steering when the run is %s', (status) => {
    const projection = projectChatTranscript(input({ ...run, status, completedAt: time(60) }))
    const segments = projection.rows.filter(row => row.kind === 'agent-turn')
    expect(segments.filter(row => row.showIdentity !== false)).toHaveLength(1)
    expect(segments.filter(row => row.ownsResultActions)).toEqual([segments.at(-1)])
    expect(segments.filter(row => row.showOutcome !== false)).toEqual([segments.at(-1)])
    expect(projection.rows.find(row => row.kind === 'message' && row.message.id === 'hello')).toMatchObject({ isIntermediate: true, showIdentity: false })
  })

  it.each(['failed', 'cancelled'] as const)('does not promote the intermediate answer when the next model request is %s before emitting text', (status) => {
    const resumed: LocalRunEvent = { runId: run.id, sequence: 4, createdAt: time(40), type: 'message.started', payload: { messageId: 'continuation', role: 'assistant' } }
    const projection = projectChatTranscript(input({ ...run, status, completedAt: time(60) }, [...events.slice(0, 3), resumed]))
    expect(projection.rows.find(row => row.kind === 'message' && row.message.id === 'hello')).toMatchObject({ isIntermediate: true, showIdentity: false })
    expect(projection.rows.filter(row => row.kind === 'agent-turn' && row.ownsResultActions)).toHaveLength(1)
    expect(projection.rows.at(-1)).toMatchObject({ kind: 'agent-turn', ownsResultActions: true, showIdentity: false })
  })

  it('rebuilds segment boundaries during incremental updates without rewriting unchanged message rows', () => {
    const projector = createChatTranscriptProjector()
    const first = input(run, events.slice(0, 3))
    const before = projector.project(first)
    const next = { ...input(), runs: first.runs, outputs: first.outputs }
    const updated = projector.project(next)
    expect(updated.rows).toEqual(projectChatTranscript(next).rows)
    expect(updated.rows[0]).toBe(before.rows[0])
    expect(order(updated).at(-1)).toBe('continuation')
  })
})
