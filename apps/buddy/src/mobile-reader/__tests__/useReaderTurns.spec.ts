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
  return { entries, runs, transcripts, topic, rows }
}

describe('mobile run rows without replies', () => {
  it.each(['queued', 'running', 'completed', 'failed', 'cancelled'] as const)('keeps the %s run after its input without depending on transcript availability', (status) => {
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

  it('replaces the visible run when switching to a branch without a reply', () => {
    const { rows, runs, entries } = reader('completed')
    entries.value = [...entries.value, entry('answer', 'assistant')]
    expect(rows.value.map(row => row.id)).toEqual(['user', 'answer'])
    entries.value = [entries.value[0]!]
    runs.value = [{ ...run('cancelled'), id: 'cancelled-run', branchId: 'cancelled-branch' }]
    expect(rows.value.map(row => row.id)).toEqual(['user', 'turn:cancelled-run'])
    expect(rows.value[1]?.turn?.status).toBe('cancelled')
  })
})
