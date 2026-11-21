import type { LocalRun } from '@buddy-shared/runs/runApi'
import type { ReaderEntry, ReaderTranscript } from '../readerBridge'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useReaderTurns } from '../useReaderTurns'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function run(status: LocalRun['status']): LocalRun {
  return { id: 'run', buddyId: 'default', approvalPolicy: 'manual', branchId: 'branch', completedAt: null, conversationId: 'conversation', errorCode: null, executionProfile: 'read_only', modelId: 'model', providerId: 'provider', purpose: 'chat', reasoningLevel: null, startedAt: '2026-11-11T05:00:00Z', status, triggeringMessageId: 'user' }
}

function entry(id: string, role: 'user' | 'assistant' | 'tool'): ReaderEntry {
  return {
    id,
    continuation: false,
    messages: [{ id, role, runId: role === 'user' ? null : 'run', authorId: null, author: 'Lexora', text: id, final: true, markdown: true, interrupted: false, truncated: false, showIdentity: true, intermediate: false, toolName: null, toolSummary: '', toolTitle: '', toolError: false, needsDetail: false, loading: false, error: null, notice: null, hasDetail: false, detailResource: null, actionsVisible: true, canEdit: false, canRegenerate: role === 'assistant', canFollowup: false, canCopy: true, resources: [] }],
  }
}

function reader(status: LocalRun['status']) {
  const entries = shallowRef([entry('user', 'user')])
  const runs = shallowRef([run(status)])
  const transcripts = shallowRef<Record<string, ReaderTranscript>>({})
  const topic = shallowRef('branch')
  const scope = effectScope()
  const rows = scope.run(() => useReaderTurns(entries, runs, transcripts, topic))!
  cleanups.push(() => scope.stop())
  return { entries, transcripts, rows }
}

describe('mobile run rows without replies', () => {
  it.each(['running', 'failed'] as const)('keeps the %s run after its input without depending on transcript availability', (status) => {
    const { rows, transcripts } = reader(status)
    const assertRun = () => {
      expect(rows.value.map(row => row.id)).toEqual(['user', 'turn:run'])
      expect(rows.value[1]).toMatchObject({ messages: [], turn: { runId: 'run', status, triggeringMessageId: 'user' } })
    }
    assertRun()
    transcripts.value = { run: { events: [], error: 'unavailable' } }
    assertRun()
    expect(rows.value[1]?.transcriptError).toBe('unavailable')
    transcripts.value = { run: { loaded: true, events: [] } }
    assertRun()
  })

  it('keeps legacy tool and reply entries until the transcript is loaded, without duplicating the run', () => {
    const { rows, entries, transcripts } = reader('completed')
    expect(rows.value.map(row => row.id)).toEqual(['user', 'turn:run'])
    entries.value = [...entries.value, entry('tool', 'tool'), entry('answer', 'assistant')]
    expect(rows.value.map(row => row.id)).toEqual(['user', 'tool', 'answer'])
    transcripts.value = { run: { loaded: true, events: [] } }
    expect(rows.value.map(row => row.id)).toEqual(['user', 'tool', 'answer'])
    transcripts.value = { run: { loaded: true, events: [{ runId: 'run', sequence: 1, createdAt: '2026-11-11T05:01:00Z', type: 'message.completed', payload: { messageId: 'answer', phase: 'final_answer', content: { text: 'answer' }, stopReason: 'stop' } }] } }
    expect(rows.value.map(row => row.id)).toEqual(['user', 'turn:run'])
    expect(rows.value[1]?.messages.map(message => message.id)).toEqual(['tool', 'answer'])
    expect(rows.value[1]?.turn?.finalMessageId).toBe('answer')
  })

  it('keeps compact groups and public narration in place without replaying a cached transcript', () => {
    const first: ReaderEntry = { id: 'group:first', continuation: true, messages: [], activityGroup: { id: 'group:first', runId: 'run', afterMessageId: null, createdAt: '2026-11-11T05:00:00Z', toolCount: 200, reasoningCount: 0, runningReasoningCount: 0, interruptedReasoningCount: 0, runningCount: 0, interruptedCount: 0, failedCount: 1, activeToolName: null, counts: [{ category: 'command', count: 200 }] } }
    const next: ReaderEntry = { ...first, id: 'group:next', activityGroup: { ...first.activityGroup!, id: 'group:next', afterMessageId: 'explanation', toolCount: 1, runningCount: 1, activeToolName: 'read', counts: [{ category: 'read', count: 1 }] } }
    const entries = shallowRef([entry('user', 'user'), first, entry('explanation', 'assistant'), next])
    const runs = shallowRef([run('running')])
    const scope = effectScope()
    cleanups.push(() => scope.stop())
    const rows = scope.run(() => useReaderTurns(entries, runs, shallowRef({ run: { loaded: true, error: 'legacy', events: [] } }), shallowRef('branch'), undefined, shallowRef(true)))!
    expect(rows.value.map(row => row.id)).toEqual(['user', 'group:first', 'explanation', 'group:next'])
    runs.value = [run('completed')]
    entries.value = [...entries.value, entry('result', 'assistant')]
    expect(rows.value.map(row => row.id)).toEqual(['user', 'group:first', 'explanation', 'group:next', 'result'])
    entries.value = [entries.value[0]!]
    runs.value = [run('failed')]
    expect(rows.value.at(-1)?.runStatus).toMatchObject({ hasReply: false, run: { id: 'run', status: 'failed' } })
  })

  it('places late public child answers and accepted steering under the initiating root, including historical pages without run records', () => {
    const row = (id: string, role: 'user' | 'assistant', seconds: number, owner?: [string, string], runId?: string) => {
      const item = entry(id, role)
      Object.assign(item.messages[0]!, { createdAt: new Date(1_800_000_000_000 + seconds * 1000).toISOString(), branchId: 'branch', runId, turnRootId: owner?.[0], turnInputId: owner?.[1] })
      return item
    }
    const entries = shallowRef([row('A', 'user', 0), row('B', 'user', 2), row('answer-B', 'assistant', 3, ['run-b', 'B'], 'run-b'), row('steer-A', 'user', 4, ['run-a', 'A']), row('child-A', 'assistant', 8, ['run-a', 'A'], 'actor-child')])
    const scope = effectScope()
    cleanups.push(() => scope.stop())
    const rows = scope.run(() => useReaderTurns(entries, shallowRef([]), shallowRef({}), shallowRef('branch'), undefined, shallowRef(true)))!
    expect(rows.value.map(item => item.id)).toEqual(['A', 'steer-A', 'child-A', 'B', 'answer-B'])
    entries.value = [...entries.value.slice(0, 3), row('unknown', 'user', 4), entries.value[4]!]
    expect(rows.value.map(item => item.id)).toEqual(['A', 'B', 'answer-B', 'unknown', 'child-A'])
  })
})
