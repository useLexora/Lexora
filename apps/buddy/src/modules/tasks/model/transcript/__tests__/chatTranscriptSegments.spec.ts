import type { LocalConversationTimelineItem } from '@buddy-shared/conversation/conversationApi'
import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { ChatRunStreamingMessage } from '../chatRunStreamingMessages'
import { describe, expect, it } from 'vitest'
import { projectExecutionGroups } from '../../executions/executionGroups'
import { projectChatAgentTurn } from '../chatAgentTurn'
import { projectChatRunStreamingMessages } from '../chatRunStreamingMessages'
import { createChatTranscriptProjector, projectChatTranscript } from '../chatTranscriptProjection'

const time = (seconds: number) => new Date(Date.UTC(2026, 8, 10, 10, 0, seconds)).toISOString()
const run: LocalRun = {
  buddyId: 'default',
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
function execution(runId: string, overrides: Partial<LocalExecution> = {}): LocalExecution {
  return {
    runId,
    rootRunId: run.id,
    parentRunId: run.id,
    buddyId: 'partner',
    buddyName: 'Partner',
    ordinal: 1,
    kind: 'actor_child',
    phase: 'closed',
    status: 'completed',
    startedAt: time(3),
    completedAt: time(10),
    updatedAt: time(10),
    progress: null,
    toolCount: 0,
    usage: null,
    stopping: false,
    task: 'Tell a story',
    waitingFor: null,
    activeChildren: 0,
    canCancel: false,
    canAnswer: false,
    canSend: false,
    cleanup: 'clean',
    errorCode: null,
    affectedResources: [],
    questions: [],
    ...overrides,
  }
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
    { sameTimestamp: true, phase: undefined },
    { sameTimestamp: false, phase: 'final_answer' },
  ])('keeps reasoning before its reply through rebuild, persistence and completion ($sameTimestamp, $phase)', ({ sameTimestamp, phase }) => {
    const history: LocalRunEvent[] = [
      { runId: run.id, sequence: 1, createdAt: time(1), type: 'message.started', payload: { messageId: 'reply', role: 'assistant' } },
      { runId: run.id, sequence: 2, createdAt: time(sameTimestamp ? 1 : 2), type: 'message.block.completed', payload: { messageId: 'reply', contentIndex: 0, kind: 'reasoning', content: 'Planning' } },
      { runId: run.id, sequence: 3, createdAt: time(3), type: 'message.delta', payload: { messageId: 'reply', contentIndex: 1, phase, delta: 'Hello' } },
      { runId: run.id, sequence: 4, createdAt: time(4), type: 'message.delta', payload: { messageId: 'reply', contentIndex: 1, phase, delta: ' world' } },
    ]
    const first = input(run, history.slice(0, 2), [message('initial', 'user', 0)])
    const projector = createChatTranscriptProjector()
    projector.project(first)
    for (const count of [3, 4]) {
      const current = { ...first, runProjections: [{ turn: projectChatAgentTurn(run, history.slice(0, count)), recoveryNotices: [], streamingMessages: projectChatRunStreamingMessages(run, history.slice(0, count)) }] }
      const live = projector.project(current)
      const rebuilt = projectChatTranscript(current)
      expect(rebuilt.rows.map(row => row.key)).toEqual(['message:initial', 'agent-turn:run', 'message:reply', 'activity:run'])
      expect(live.rows).toEqual(rebuilt.rows)
      expect(rebuilt.rows[1]).toMatchObject({ turn: { nodes: [{ kind: 'reasoning', messageId: 'reply' }] } })
    }
    const done = [...history, { runId: run.id, sequence: 5, createdAt: time(5), type: 'message.completed', payload: { messageId: 'reply', phase: 'final_answer', content: { text: 'Hello world' } } }]
    for (const status of ['running', 'completed'] as const) {
      const currentRun = { ...run, status, completedAt: status === 'running' ? null : time(6) }
      const current = input(currentRun, done, [message('initial', 'user', 0), message('reply', 'assistant', 5)])
      const replay = projectChatTranscript(current)
      expect(replay.rows.slice(0, 3).map(row => row.key)).toEqual(['message:initial', 'agent-turn:run', 'message:reply'])
      expect(projector.project(current).rows).toEqual(replay.rows)
    }
  })

  it.each(['user', 'assistant'] as const)('keeps preceding actions with reasoning and later reasoning with its own reply around another %s message', (role) => {
    const history: LocalRunEvent[] = [
      { runId: run.id, sequence: 1, createdAt: time(1), type: 'message.started', payload: { messageId: 'first', role: 'assistant' } },
      { runId: run.id, sequence: 2, createdAt: time(3), type: 'message.block.completed', payload: { messageId: 'first', contentIndex: 0, kind: 'reasoning', content: 'First thought' } },
      { runId: run.id, sequence: 3, createdAt: time(4), type: 'message.completed', payload: { messageId: 'first', phase: 'final_answer', content: { text: 'First reply' } } },
      { runId: run.id, sequence: 4, createdAt: time(6), type: 'message.started', payload: { messageId: 'second', role: 'assistant' } },
      { runId: run.id, sequence: 5, createdAt: time(8), type: 'message.block.completed', payload: { messageId: 'second', contentIndex: 0, kind: 'reasoning', content: 'Second thought' } },
      { runId: run.id, sequence: 6, createdAt: time(9), type: 'message.delta', payload: { messageId: 'second', contentIndex: 1, delta: 'Second reply' } },
    ]
    const interjection = { ...message('interjection', role, 5), runId: role === 'assistant' ? 'other-run' : null }
    const items = [message('initial', 'user', 0), message('first', 'assistant', 4), interjection, action(2), action(7)]
    const current = input(run, history, items)
    current.runProjections[0]!.streamingMessages = projectChatRunStreamingMessages(run, history)
    const projected = projectChatTranscript(current)
    const contents = projected.rows.flatMap(row => row.kind === 'message' ? [row.message.id] : row.kind === 'agent-turn' ? row.turn.nodes.map(node => node.id) : [])
    expect(contents).toEqual(['initial', 'extension-action:action-2', 'reasoning:first:0', 'first', 'interjection', 'extension-action:action-7', 'reasoning:second:0', 'second'])
  })

  it('keeps completed speeches in place and restores the caller identity after another actor speaks', () => {
    const actorReply = (id: string, actor: string, seconds: number) => ({ ...message(id, 'assistant', seconds), runId: actor })
    const items = [message('initial', 'user', 0), actorReply('actor-a', 'actor-a-run', 10), actorReply('actor-a-again', 'actor-a-run', 11)]
    const first = input(run, events.slice(0, 1), items)
    const projector = createChatTranscriptProjector()
    const initial = projector.project(first)
    const earlier = initial.rows.find(row => row.kind === 'agent-turn')!
    expect(earlier).toMatchObject({ showOutcome: false, turn: { nodes: [{ messageId: 'before' }] } })
    const resumed = { ...first, runProjections: input(run, events.slice(0, 2), items).runProjections }
    const continuation = projector.project(resumed)
    expect(continuation.rows).toEqual(projectChatTranscript(resumed).rows)
    expect(order(continuation)).toEqual(['initial', 'before', 'actor-a', 'actor-a-again', 'between'])
    expect(continuation.rows.find(row => row.key === earlier.key)).toMatchObject({ key: earlier.key, showOutcome: false, turn: { nodes: earlier.kind === 'agent-turn' ? earlier.turn.nodes : [] } })
    const identities = (projection: ReturnType<typeof projectChatTranscript>) => projection.rows.flatMap(row => 'showIdentity' in row && row.showIdentity === false
      ? []
      : row.kind === 'agent-turn'
        ? [row.turn.runId]
        : row.kind === 'message' && row.message.role === 'assistant' ? [row.message.runId] : [])
    expect(identities(continuation)).toEqual(['run', 'actor-a-run', 'run'])
    const terminal = input({ ...run, status: 'completed', completedAt: time(45) }, [...events, { runId: run.id, sequence: 5, createdAt: time(45), type: 'message.completed', payload: { role: 'assistant', messageId: 'final', phase: 'final_answer', content: { text: 'Done' } } }], [...items, actorReply('actor-b', 'actor-b-run', 35), message('hello', 'assistant', 31), message('final', 'assistant', 45)])
    const completed = projector.project(terminal)
    expect(identities(completed)).toEqual(['run', 'actor-a-run', 'run', 'actor-b-run', 'run'])
    expect(order(completed)).toEqual(['initial', 'before', 'actor-a', 'actor-a-again', 'between', 'hello', 'actor-b', 'continuation', 'final'])
    expect(completed.rows).toEqual(projectChatTranscript(terminal).rows)
    expect(completed.rows.filter(row => row.kind === 'message' && row.resultRunId).map(row => row.key)).toEqual(['message:final'])
  })

  it.each([false, true])('keeps public actor replies and independent root outcomes in place with start metadata (root events: %s)', (withRootStart) => {
    const completed = { ...run, status: 'completed' as const, completedAt: time(75) }
    const followup = { ...completed, id: 'followup-run', buddyId: 'other-actor', triggeringMessageId: 'followup', startedAt: time(30), completedAt: time(45) }
    const reply = (id: string, runId: string, startedAt: number, createdAt: number, phase: 'commentary' | 'final_answer' = 'final_answer') => ({ ...message(id, 'assistant', createdAt), runId, startedAt: time(startedAt), content: { text: id, phase } })
    const history: LocalRunEvent[] = [
      events[0]!,
      { runId: run.id, sequence: 2, createdAt: time(70), type: 'message.completed', payload: { messageId: 'caller-final', role: 'assistant', phase: 'final_answer', content: { text: 'Done' } } },
      ...(withRootStart ? [{ runId: followup.id, sequence: 1, createdAt: time(32), type: 'message.started', payload: { messageId: 'followup-answer', role: 'assistant' } }] : []),
      { runId: followup.id, sequence: 2, createdAt: time(40), type: 'message.completed', payload: { messageId: 'followup-answer', role: 'assistant', phase: 'final_answer', content: { text: 'Follow-up answer' } } },
    ]
    const snapshot = {
      runs: [completed, followup],
      runEvents: history,
      outputs: [],
      executionGroups: projectExecutionGroups([
        execution(run.id, { kind: 'root', buddyId: 'default', parentRunId: null, ordinal: null, startedAt: completed.startedAt, completedAt: completed.completedAt }),
        execution('partner-run', { completedAt: time(60) }),
        execution(followup.id, { kind: 'root', buddyId: followup.buddyId, rootRunId: followup.id, parentRunId: null, ordinal: null, startedAt: followup.startedAt, completedAt: followup.completedAt }),
      ]),
      timelineItems: [
        message('initial', 'user', 0),
        message('followup', 'user', 30),
        reply('partner-opening', 'partner-run', 10, 35, 'commentary'),
        reply('followup-answer', followup.id, 32, 40),
        reply('partner-progress', 'partner-run', 41, 43, 'commentary'),
        reply('partner-final', 'partner-run', 55, 60),
        reply('caller-final', run.id, 65, 70),
      ],
    }
    const projector = createChatTranscriptProjector()
    projector.project({ ...snapshot, timelineItems: snapshot.timelineItems.slice(0, 4) })
    const result = projector.project(snapshot)
    expect(order(result)).toEqual(['initial', 'before', 'partner-opening', 'partner-progress', 'partner-final', 'caller-final', 'followup', 'followup-answer'])
    expect(result.rows.find(row => row.key === 'message:followup-answer')).toMatchObject({ turnResult: { runId: followup.id } })
    expect(result.rows.find(row => row.key === 'message:caller-final')).toMatchObject({ turnResult: { runId: run.id } })
    expect(result.rows.find(row => row.key === 'message:partner-progress')).toHaveProperty('showIdentity', false)
    expect(result.rows.filter(row => row.kind === 'turn-result')).toEqual([])
  })

  it('does not reopen the caller speech for orchestration tools between partner messages', () => {
    const actorReply = (id: string, seconds: number) => ({ ...message(id, 'assistant', seconds), runId: 'partner-run' })
    const presentation = { card: 'generic', argumentNames: [], description: null, output: null, truncated: false }
    const history: LocalRunEvent[] = [events[0]!, { runId: run.id, sequence: 2, createdAt: time(12), type: 'tool.completed', payload: { toolCallId: 'wait', toolName: 'lexora_agents', presentation } }]
    const items = [message('initial', 'user', 0), actorReply('partner-before', 10), actorReply('partner-after', 15)]
    const result = projectChatTranscript(input(run, history, items))
    const messages = result.rows.filter(row => row.kind === 'message' && row.message.role === 'assistant')
    expect(messages).toMatchObject([{ message: { id: 'partner-before' }, showActions: false }, { message: { id: 'partner-after' }, showIdentity: false, actionMessages: [{ id: 'partner-before' }, { id: 'partner-after' }] }])
    expect(result.rows.filter(row => row.kind === 'agent-turn').flatMap(row => row.turn.nodes).some(node => node.kind === 'tool' && node.toolName === 'lexora_agents')).toBe(false)
    const resumed = projectChatTranscript(input(run, [...history, { ...events[1]!, sequence: 3 }], items))
    const continuation = resumed.rows.find(row => row.kind === 'agent-turn' && row.turn.nodes.some(node => node.kind === 'text' && node.messageId === 'between'))
    expect(continuation).toBeDefined()
    expect(continuation).not.toHaveProperty('showIdentity', false)
  })

  it('keeps terminal status on the first identity of each execution, including repeated runs of the same actor', () => {
    const completed = { ...run, status: 'completed' as const, completedAt: time(30) }
    const records = [execution(run.id, { kind: 'root', buddyId: 'caller', parentRunId: null, ordinal: null, startedAt: time(0), completedAt: time(30) }), execution('partner-first'), execution('partner-resumed', { ordinal: 2, startedAt: time(12), completedAt: time(20) })]
    const rootContinuation: LocalRunEvent = { runId: run.id, sequence: 2, createdAt: time(25), type: 'message.completed', payload: { messageId: 'continued', role: 'assistant', phase: 'commentary', content: { text: 'Both assignments are complete.' } } }
    const items = [message('initial', 'user', 0), { ...message('first-answer', 'assistant', 10), runId: 'partner-first' }, { ...message('continued-answer', 'assistant', 20), runId: 'partner-resumed' }]
    const snapshot = { ...input(completed, [events[0]!, rootContinuation], items), executionGroups: projectExecutionGroups(records) }
    const projector = createChatTranscriptProjector()
    projector.project({ ...snapshot, runs: [run], runProjections: input(run, [events[0]!, rootContinuation], items).runProjections, executionGroups: projectExecutionGroups([{ ...records[0]!, status: 'running', phase: 'working', completedAt: null }, ...records.slice(1)]) })
    const result = projector.project(snapshot)
    const statuses = result.rows.flatMap(row => (row.kind === 'message' || row.kind === 'agent-turn') && row.executionStatus
      ? [{ runId: row.kind === 'message' ? row.message.runId : row.turn.runId, ...row.executionStatus }]
      : [])
    expect(statuses).toEqual([
      { runId: run.id, status: 'completed', startedAt: time(0), completedAt: time(30) },
      { runId: 'partner-first', status: 'completed', startedAt: time(3), completedAt: time(10) },
      { runId: 'partner-resumed', status: 'completed', startedAt: time(12), completedAt: time(20) },
    ])
    expect(result.rows.find(row => row.kind === 'message' && row.message.id === 'continued-answer')).not.toHaveProperty('showIdentity', false)
    const callerRows = result.rows.filter(row => row.kind === 'agent-turn' && row.turn.runId === run.id)
    expect(callerRows).toHaveLength(2)
    expect(callerRows[1]).not.toHaveProperty('executionStatus')
    expect(result.rows.at(-1)).toMatchObject({ kind: 'turn-result' })
    expect(result.rows.at(-1)).not.toHaveProperty('executionStatus')
  })

  it.each([false, true])('keeps a completed caller outcome after the partner answer when the caller has no final text (process: %s)', (withProcess) => {
    const partner = { ...message('partner-final', 'assistant', 10), runId: 'partner-run' }
    const emptyFinal = { ...message('empty-final', 'assistant', 20), content: { text: '' } }
    const history = withProcess ? events.slice(0, 1) : []
    const completed = { ...run, status: 'completed' as const, completedAt: time(20) }
    const done: LocalRunEvent = { runId: run.id, sequence: 2, createdAt: time(20), type: 'message.completed', payload: { messageId: emptyFinal.id, role: 'assistant', phase: 'final_answer', content: { text: '' } } }
    const projector = createChatTranscriptProjector()
    const live = projector.project(input(run, history, [message('initial', 'user', 0), partner]))
    expect(live.rows.some(row => row.kind === 'agent-turn' && row.ownsResultActions)).toBe(false)

    const snapshot = {
      ...input(completed, [...history, done], [message('initial', 'user', 0), partner, emptyFinal]),
      executionGroups: projectExecutionGroups([
        execution(run.id, { kind: 'root', buddyId: 'default', parentRunId: null, ordinal: null, startedAt: completed.startedAt, completedAt: completed.completedAt }),
        execution('partner-run'),
      ]),
    }
    const result = projector.project(snapshot)
    const reply = result.rows.at(-1)!
    expect(reply).toMatchObject({ kind: 'message', message: { id: partner.id }, turnResult: { runId: run.id, status: 'completed', nodes: [] } })
    expect(reply).not.toHaveProperty('resultRunId')
    expect(reply).not.toHaveProperty('showActions', false)
    expect(result.rows.filter(row => row.kind === 'turn-result')).toEqual([])
    expect(result.rows.filter(row => row.kind === 'agent-turn' && !row.turn.nodes.length)).toEqual([])
    expect(result.rows.some(row => row.kind === 'message' && row.message.id === emptyFinal.id)).toBe(false)
  })

  it('joins the returning caller output tool and final answer under one identity', () => {
    const presentation = { card: 'generic', argumentNames: [], description: null, output: null, truncated: false }
    const completed = { ...run, status: 'completed' as const, completedAt: time(30) }
    const history: LocalRunEvent[] = [events[0]!, { runId: run.id, sequence: 2, createdAt: time(20), type: 'tool.completed', payload: { toolCallId: 'present', toolName: 'lexora_output_present', presentation } }, { runId: run.id, sequence: 3, createdAt: time(30), type: 'message.completed', payload: { role: 'assistant', messageId: 'final', phase: 'final_answer', content: { text: 'Done' } } }]
    const items = [message('initial', 'user', 0), { ...message('partner', 'assistant', 10), runId: 'partner-run' }, message('final', 'assistant', 30)]
    const projector = createChatTranscriptProjector()
    const live = projector.project(input(run, history.slice(0, 2), items.slice(0, 2)))
    const visible = live.rows.find(row => row.kind === 'agent-turn' && row.turn.nodes.some(node => node.kind === 'tool'))!
    expect(visible).not.toHaveProperty('showIdentity', false)
    const result = projector.project(input(completed, history, items))
    expect(result.rows.find(row => row.key === visible.key)).toMatchObject({ turn: { nodes: [{ toolName: 'lexora_output_present' }] } })
    expect(result.rows.find(row => row.kind === 'message' && row.message.id === 'final')).toMatchObject({ showIdentity: false, resultRunId: 'run' })
    expect(result.rows.find(row => row.kind === 'message' && row.message.id === 'partner')).toMatchObject({ endsSpeech: true })
    expect(result.rows.find(row => row.kind === 'agent-turn')).toMatchObject({ endsSpeech: true })
  })

  it.each([
    { trigger: 'task:input:committed', seconds: 1 },
    { trigger: 'task:turn:completed', seconds: 6 },
    { trigger: 'user', seconds: 6 },
  ] as const)('keeps $trigger actions at $seconds in the originating reply flow during updates and replay', ({ trigger, seconds }) => {
    const completed = { ...run, status: 'completed' as const, completedAt: time(5) }
    const reply: LocalRunEvent = { runId: run.id, sequence: 1, createdAt: time(5), type: 'message.completed', payload: { role: 'assistant', messageId: 'reply', phase: 'final_answer', content: { text: 'Done' } } }
    const messages = [message('initial', 'user', 0), message('reply', 'assistant', 5)]
    const projector = createChatTranscriptProjector()
    for (const status of ['running', 'completed'] as const) {
      const invocation = action(seconds, { trigger, status, completedAt: status === 'running' ? null : time(seconds + 1) })
      const snapshot = input(completed, [reply], [...messages, invocation])
      const projected = projector.project(snapshot)
      expect(projected.rows.map(row => row.key)).toEqual(['message:initial', 'agent-turn:run', 'message:reply'])
      expect(projected.rows[1]).toMatchObject({ turn: { status: 'completed', nodes: [{ kind: 'tool', invocation }] } })
      expect(projected.rows[2]).toMatchObject({ showIdentity: false, resultRunId: run.id, turnResult: { runId: run.id } })
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
    const result = projectChatTranscript(input(completed, toolEvents, [message('initial', 'user', 0), message('reply', 'assistant', 10), action(3), action(11)]))
    const nodes = result.rows.flatMap(row => row.kind === 'agent-turn' ? row.turn.nodes : [])
    expect(nodes.map(node => node.id)).toEqual(['extension-action:action-3', 'tool:read', 'tool:plugin', 'extension-action:action-11'])
    expect(result.rows.at(-1)).toMatchObject({ key: 'message:reply', turnResult: { runId: run.id } })
  })

  it('keeps the avatar before leading actions while the first reply arrives and when it is cancelled', () => {
    const items = [message('initial', 'user', 0), action(1), action(2)]
    const first = input(run, [], items)
    const projector = createChatTranscriptProjector()
    expect(projector.project(first).rows.map(row => row.key)).toEqual(['message:initial', 'agent-turn:run', 'activity:run'])
    const narration: LocalRunEvent = { runId: run.id, sequence: 1, createdAt: time(3), type: 'message.completed', payload: { role: 'assistant', messageId: 'reply', phase: 'commentary', content: { text: 'Working' } } }
    const next = { ...first, runProjections: input(run, [narration], items).runProjections }
    const active = projector.project(next)
    expect(active.rows.map(row => row.key)).toEqual(['message:initial', 'agent-turn:run', 'activity:run'])
    expect(active.rows[1]).toMatchObject({ kind: 'agent-turn', turn: { nodes: [{ id: 'extension-action:action-1' }, { id: 'extension-action:action-2' }, { messageId: 'reply' }] } })
    const ended = projector.project(input({ ...run, status: 'cancelled', completedAt: time(5) }, [narration], items))
    expect(ended.rows.filter(row => row.kind === 'agent-turn' && row.showIdentity !== false).map(row => row.key)).toEqual(['agent-turn:run'])
    expect(ended.rows.at(-1)).toMatchObject({ kind: 'agent-turn', ownsResultActions: true })
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

  it('preserves steering order and intermediate answers through incremental updates, completion and replay', () => {
    const projector = createChatTranscriptProjector()
    const first = input(run, events.slice(0, 3))
    projector.project(first)
    const next = { ...input(), runs: first.runs, outputs: first.outputs }
    const projection = projector.project(next)
    expect(projection.rows).toEqual(projectChatTranscript(next).rows)
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

    const completed: LocalRun = { ...run, status: 'completed', completedAt: time(60) }
    const terminalEvents = [...events, { runId: run.id, sequence: 5, createdAt: time(60), type: 'message.completed', payload: { role: 'assistant', messageId: 'final', phase: 'final_answer', content: { text: 'final' } } }]
    const terminal = input(completed, terminalEvents, [...timelineItems, message('final', 'assistant', 60)])
    const result = projector.project(terminal)
    expect(result.rows).toEqual(projectChatTranscript(terminal).rows)
    expect(order(result)).toEqual([...order(projection), 'final'])
    expect(result.rows.filter(row => row.kind === 'message' && row.resultRunId).map(row => row.key)).toEqual(['message:final'])
    expect(result.rows.find(row => row.kind === 'message' && row.message.id === 'hello')).toMatchObject({ isIntermediate: true, showIdentity: false })
    expect(result.rows.find(row => row.kind === 'message' && row.message.id === 'final')).toMatchObject({ showIdentity: false, resultRunId: run.id })
    expect(result.rows.find(row => row.kind === 'message' && row.message.id === 'final')).not.toHaveProperty('isIntermediate')
    expect(result.rows.filter(row => row.kind === 'agent-turn').map(row => row.key)).toEqual(segments.map(row => row.key))
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

  it.each(['failed', 'cancelled'] as const)('keeps one terminal outcome without promoting intermediate answers when %s', (status) => {
    const resumed: LocalRunEvent = { runId: run.id, sequence: 4, createdAt: time(40), type: 'message.started', payload: { messageId: 'continuation', role: 'assistant' } }
    for (const history of [events, [...events.slice(0, 3), resumed]]) {
      const projection = projectChatTranscript(input({ ...run, status, completedAt: time(60) }, history))
      const segments = projection.rows.filter(row => row.kind === 'agent-turn')
      expect(segments.filter(row => row.showIdentity !== false)).toHaveLength(1)
      expect(segments.filter(row => row.ownsResultActions)).toEqual([segments.at(-1)])
      expect(segments.filter(row => row.showOutcome !== false)).toEqual([segments.at(-1)])
      expect(projection.rows.find(row => row.kind === 'message' && row.message.id === 'hello')).toMatchObject({ isIntermediate: true, showIdentity: false })
      expect(projection.rows.at(-1)).toMatchObject({ kind: 'agent-turn', ownsResultActions: true, showIdentity: false })
    }
  })
})
