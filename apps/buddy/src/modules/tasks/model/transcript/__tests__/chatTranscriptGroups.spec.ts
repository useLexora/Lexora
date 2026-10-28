import type { LocalConversationTimelineItem } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'
import { describe, expect, it } from 'vitest'
import { projectChatAgentTurn } from '../chatAgentTurn'
import { projectChatTranscriptDisplayRows } from '../chatMessageTime'
import { projectChatRunStreamingMessages } from '../chatRunStreamingMessages'
import { createChatTranscriptProjector, projectChatTranscript } from '../chatTranscriptProjection'

const time = (seconds: number) => new Date(Date.UTC(2026, 8, 10, 10, 0, seconds)).toISOString()
function run(id: string, start: number, completedAt: number | null = null): LocalRun {
  return { id, buddyId: 'default', branchId: 'branch', conversationId: 'conversation', triggeringMessageId: `input-${id}`, status: completedAt === null ? 'running' : 'completed', startedAt: time(start), completedAt: completedAt === null ? null : time(completedAt), approvalPolicy: 'policy', executionProfile: 'workspace_write', modelId: 'model', providerId: 'provider', purpose: 'chat', reasoningLevel: null, errorCode: null }
}
function message(id: string, seconds: number, runId: string | null = null): Extract<LocalConversationTimelineItem, { kind: 'message' }> {
  return { kind: 'message', id, role: runId ? 'assistant' : 'user', branchId: 'branch', conversationId: 'conversation', runId, attachments: [], content: { text: id }, createdAt: time(seconds) }
}
function event(runId: string, sequence: number, seconds: number, type: string, payload: LocalRunEvent['payload']): LocalRunEvent {
  return { runId, sequence, createdAt: time(seconds), type, payload }
}
function projection(run: LocalRun, events: readonly LocalRunEvent[]) {
  return { turn: projectChatAgentTurn(run, events), recoveryNotices: [], streamingMessages: projectChatRunStreamingMessages(run, events) }
}
function order(result: ReturnType<typeof projectChatTranscript>) {
  return result.rows.flatMap(row => row.kind === 'message' ? [row.message.id] : row.kind === 'activity' ? [row.key] : [])
}

describe('causal conversation groups', () => {
  it('retains both concurrent streams and activity rows in their own initiating groups through incremental updates', () => {
    const a = run('a', 0)
    const b = run('b', 10)
    const aEvents = [event(a.id, 1, 12, 'message.started', { messageId: 'answer-a', role: 'assistant' }), event(a.id, 2, 14, 'message.delta', { messageId: 'answer-a', phase: 'final_answer', delta: 'A is working' })]
    const bEvents = [event(b.id, 1, 11, 'message.started', { messageId: 'answer-b', role: 'assistant' }), event(b.id, 2, 13, 'message.delta', { messageId: 'answer-b', phase: 'final_answer', delta: 'B is working' })]
    const snapshot = { runs: [b, a], outputs: [], timelineItems: [message('input-a', 0), message('input-b', 10)], runProjections: [projection(b, bEvents), projection(a, aEvents)] }
    const projector = createChatTranscriptProjector()
    const initial = projector.project(snapshot)
    expect(order(initial)).toEqual(['input-a', 'answer-a', 'activity:a', 'input-b', 'answer-b', 'activity:b'])
    expect(initial.rows.filter(row => row.kind === 'message' && row.streaming)).toHaveLength(2)
    const updated = { ...snapshot, runProjections: [snapshot.runProjections[0]!, projection(a, [...aEvents, event(a.id, 3, 15, 'message.delta', { messageId: 'answer-a', phase: 'final_answer', delta: ' and progressing' })])] }
    const result = projector.project(updated)
    expect(result.rows).toEqual(projectChatTranscript(updated).rows)
    expect(order(result)).toEqual(order(initial))
    expect(result.rows.find(row => row.key === 'message:answer-a')).toMatchObject({ message: { content: { text: 'A is working and progressing' } } })
  })

  it('keeps the earlier activity before a completed later turn and attaches each result to its own root', () => {
    const a = run('a', 0)
    const b = run('b', 10, 20)
    const bDone = event(b.id, 1, 19, 'message.completed', { messageId: 'answer-b', role: 'assistant', phase: 'final_answer', content: { text: 'Done B' } })
    const snapshot = { runs: [a, b], outputs: [], timelineItems: [message('input-a', 0), message('input-b', 10), message('answer-b', 19, b.id)], runEvents: [bDone] }
    const projector = createChatTranscriptProjector()
    const initial = projector.project(snapshot)
    expect(order(initial)).toEqual(['input-a', 'activity:a', 'input-b', 'answer-b'])
    const done = { ...snapshot, runs: [{ ...a, status: 'completed' as const, completedAt: time(40) }, b], timelineItems: [...snapshot.timelineItems, message('answer-a', 39, a.id)], runEvents: [...snapshot.runEvents, event(a.id, 1, 39, 'message.completed', { messageId: 'answer-a', role: 'assistant', phase: 'final_answer', content: { text: 'Done A' } })] }
    const result = projector.project(done)
    expect(result.rows).toEqual(projectChatTranscript(done).rows)
    expect(order(result)).toEqual(['input-a', 'answer-a', 'input-b', 'answer-b'])
    for (const id of ['a', 'b'])
      expect(result.rows.find(row => row.key === `message:answer-${id}`)).toMatchObject({ turnResult: { runId: id } })
  })

  it('retains both streams when the second run begins before its trigger is loaded', () => {
    const a = run('a', 0)
    const c = run('c', 10)
    const aEvents = [event(a.id, 1, 1, 'message.started', { messageId: 'answer-a', role: 'assistant' }), event(a.id, 2, 2, 'message.delta', { messageId: 'answer-a', phase: 'final_answer', delta: 'A is visible' })]
    const snapshot = { runs: [a, c], outputs: [], timelineItems: [message('input-a', 0)], runProjections: [projection(a, aEvents), projection(c, [])] }
    const projector = createChatTranscriptProjector()
    projector.project(snapshot)
    const cEvents = [event(c.id, 1, 11, 'message.started', { messageId: 'answer-c', role: 'assistant' }), event(c.id, 2, 12, 'message.delta', { messageId: 'answer-c', phase: 'final_answer', delta: 'C also becomes visible' })]
    const updated = { ...snapshot, runProjections: [snapshot.runProjections[0]!, projection(c, cEvents)] }
    const result = projector.project(updated)
    expect(result.rows).toEqual(projectChatTranscript(updated).rows)
    expect(result.rows.flatMap(row => row.kind === 'message' && row.streaming ? [row.message.id] : [])).toEqual(['answer-a', 'answer-c'])
  })

  it.each(['a', 'unloaded-child'])('keeps delayed input actions with accepted execution %s without borrowing a concurrent run', (inputRunId) => {
    const snapshot = {
      runs: [run('a', 0, 40), run('b', 10, 30)],
      outputs: [],
      timelineItems: [
        message('input-a', 0),
        message('input-b', 10),
        { ...message('steering-a', 15), inputRunId },
        { kind: 'extension-action' as const, id: 'delayed-action', conversationId: 'conversation', branchId: 'branch', sourceMessageId: 'steering-a', extensionId: 'tests.title', extensionName: 'Title', actionId: 'tests.title.generate', title: 'Generate title', trigger: 'task:input:committed' as const, status: 'completed' as const, message: 'Updated', createdAt: time(41), completedAt: time(42) },
      ],
    }
    const rows = projectChatTranscript(snapshot).rows
    const owners = rows.flatMap(row => row.kind === 'agent-turn' && row.turn.nodes.some(node => node.kind === 'tool' && node.invocation?.id === 'delayed-action') ? [row.turn.runId] : [])
    expect(owners).toEqual(inputRunId === 'a' ? ['a'] : [])
    if (inputRunId !== 'a')
      expect(rows.find(row => row.kind === 'activity-flow')).toMatchObject({ nodes: [{ invocation: { id: 'delayed-action', sourceMessageId: 'steering-a' } }] })
  })

  it('uses the current trigger attempt for plugin actions when regeneration inherits the original input', () => {
    const revised = { ...run('revised', 20, 40), branchId: 'revised-branch', triggeringMessageId: 'input-a' }
    const result = projectChatTranscript({
      runs: [revised],
      outputs: [],
      timelineItems: [
        { ...message('input-a', 0), inputRunId: 'original-run' },
        { kind: 'extension-action', id: 'revised-action', conversationId: 'conversation', branchId: revised.branchId, sourceMessageId: 'input-a', extensionId: 'tests.title', extensionName: 'Title', actionId: 'tests.title.generate', title: 'Generate title', trigger: 'task:input:committed', status: 'completed', message: 'Updated', createdAt: time(21), completedAt: time(22) },
      ],
    })
    expect(result.rows.find(row => row.kind === 'agent-turn')).toMatchObject({ turn: { runId: revised.id, nodes: [{ invocation: { id: 'revised-action' } }] } })
  })

  it('anchors day dividers to initiating inputs when a previous round finishes after midnight', () => {
    const snapshot = {
      runs: [run('a', 0, 86430), run('b', 10, 30), run('c', 86440)],
      outputs: [],
      timelineItems: [message('input-a', 0), message('input-b', 10), message('answer-b', 25, 'b'), message('answer-a', 86420, 'a'), message('input-c', 86440)],
    }
    const result = projectChatTranscript(snapshot)
    expect(order(result)).toEqual(['input-a', 'answer-a', 'input-b', 'answer-b', 'input-c', 'activity:c'])
    const display = projectChatTranscriptDisplayRows(result.rows)
    expect(display.filter(row => row.kind === 'day-divider').map(row => row.createdAt)).toEqual([time(0), time(86440)])
    expect(new Set(display.map(row => row.key)).size).toBe(display.length)
    expect(result.rows.find(row => row.key === 'message:answer-a')).toMatchObject({ message: { createdAt: time(86420) } })
  })

  it('keeps accepted steering with its actual execution instead of the most recent input or actor', () => {
    const a = run('a', 0, 40)
    const b = run('b', 10, 30)
    const steering = { ...message('steering-a', 15), inputRunId: a.id }
    const snapshot = { runs: [a, b], outputs: [], timelineItems: [message('input-a', 0), message('opening-a', 5, a.id), message('input-b', 10), steering, message('answer-b', 25, b.id), message('answer-a', 35, a.id)] }
    const original = structuredClone(snapshot.timelineItems)
    expect(order(projectChatTranscript(snapshot))).toEqual(['input-a', 'opening-a', 'steering-a', 'answer-a', 'input-b', 'answer-b'])
    expect(snapshot.timelineItems).toEqual(original)
    for (const inputRunId of [undefined, 'unloaded-child']) {
      const legacy = { ...snapshot, timelineItems: snapshot.timelineItems.map(item => item.id === steering.id ? { ...message(steering.id, 15), inputRunId } : item) }
      expect(order(projectChatTranscript(legacy))).toEqual(['input-a', 'opening-a', 'input-b', 'steering-a', 'answer-b', 'answer-a'])
    }
  })
})
