import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { ChatAgentTurn } from '../chatAgentTurn'
import type { ChatTranscriptMessageRow, ChatTranscriptRow } from '../chatTranscriptTypes'
import { describe, expect, it } from 'vitest'
import { projectExecutionGroups } from '../../executions/executionGroups'
import { projectChatMessageBranchNavigators } from '../chatMessageBranches'
import { presentChatTranscript } from '../chatTranscriptPresentation'

const time = (seconds: number) => new Date(Date.UTC(2026, 9, 26, 10, 0, seconds)).toISOString()
const turn: ChatAgentTurn = {
  branchId: 'branch',
  runId: 'root',
  triggeringMessageId: 'input',
  status: 'completed',
  startedAt: time(0),
  completedAt: time(30),
  finalMessageId: null,
  nodes: [],
  processMessageIds: [],
  progress: null,
  reasoningLevel: null,
  usage: null,
}
const result: ChatTranscriptRow = { kind: 'turn-result', key: 'turn-result:root', turn }
function reply(runId: string, id = 'reply'): ChatTranscriptMessageRow {
  return { kind: 'message', key: `message:${id}`, turnOutputs: null, message: { id, runId, role: 'assistant', branchId: 'branch', conversationId: 'conversation', createdAt: time(10), attachments: [], content: { text: id } } }
}
function execution(runId: string, rootRunId = 'root'): LocalExecution {
  return {
    runId,
    rootRunId,
    parentRunId: rootRunId,
    buddyId: runId,
    buddyName: runId,
    ordinal: 1,
    kind: 'actor_child',
    phase: 'closed',
    status: 'completed',
    startedAt: time(1),
    completedAt: time(10),
    updatedAt: time(10),
    progress: null,
    toolCount: 0,
    usage: null,
    stopping: false,
    task: 'Write a story',
    waitingFor: null,
    activeChildren: 0,
    canCancel: false,
    canAnswer: false,
    canSend: false,
    cleanup: 'clean',
    errorCode: null,
    affectedResources: [],
    questions: [],
  }
}

describe('completed turn action association', () => {
  it('combines only the last same-tree speech while preserving child authorship, copy content, time and artifacts', () => {
    const earlier = reply('root', 'earlier')
    const first = reply('child', 'first-part')
    const last = reply('child')
    last.resultRunId = 'child'
    last.turnOutputs = { runId: 'child', artifacts: [{ artifactId: 'story', conversationId: 'conversation', createdAt: time(10), updatedAt: time(10), kind: 'file', mimeType: 'text/html', name: 'story.html', path: '/workspace/story.html', previewUrl: null, runId: 'child', sizeBytes: 100, sourceArtifactId: null, sourceToolCallId: 'write-story' }] }
    const rows = presentChatTranscript([earlier, first, last, result], projectExecutionGroups([execution('child')])).rows
    expect(rows).toHaveLength(3)
    expect(rows[0]).not.toHaveProperty('turnResult')
    expect(rows[0]).not.toHaveProperty('showActions', false)
    expect(rows[2]).toMatchObject({ kind: 'message', message: { runId: 'child', createdAt: time(10) }, resultRunId: 'child', turnResult: turn, actionMessages: [first.message, last.message] })
    expect(rows[2]?.kind === 'message' && rows[2].turnOutputs).toBe(last.turnOutputs)
    expect(rows[2]).not.toHaveProperty('showActions', false)
    expect(last).not.toHaveProperty('turnResult')
  })

  it.each(['other-root', 'unknown', 'other-branch', 'streaming', 'user', 'activity', 'process'] as const)('keeps an independent result across the %s boundary', (boundary) => {
    const last = reply('child')
    const rows: ChatTranscriptRow[] = [last]
    if (boundary === 'other-branch')
      last.message = { ...last.message, branchId: 'other-branch' }
    if (boundary === 'streaming')
      last.streaming = true
    if (boundary === 'user')
      rows.push({ ...reply('root', 'next-input'), message: { ...reply('root', 'next-input').message, role: 'user', runId: null } })
    if (boundary === 'activity')
      rows.push({ kind: 'activity-flow', key: 'extension-action', createdAt: time(20), nodes: [] })
    if (boundary === 'process')
      rows.push({ kind: 'agent-turn', key: 'process', turn: { ...turn, nodes: [{ kind: 'text', id: 'process', messageId: 'process', text: 'Reviewing' }] } })
    const groups = boundary === 'unknown' ? undefined : projectExecutionGroups([execution('child', boundary === 'other-root' ? 'other-root' : 'root')])
    const actual = presentChatTranscript([...rows, result], groups).rows
    expect(actual.at(-1)).toBe(result)
    expect(actual.filter(row => row.kind === 'message').every(row => !row.turnResult)).toBe(true)
  })

  it('keeps retry navigation on the root after associating its result with a child reply', () => {
    const input = { ...reply('root', 'input'), message: { ...reply('root', 'input').message, role: 'user' as const, runId: null } }
    const rows = presentChatTranscript([input, reply('child'), result], projectExecutionGroups([execution('child')])).rows
    const base = { id: 'branch', conversationId: 'conversation', parentBranchId: null, forkedFromMessageId: null, createdAt: time(0) }
    const navigators = projectChatMessageBranchNavigators(rows, [base, { ...base, id: 'retry', parentBranchId: 'branch', forkedFromMessageId: 'input', createdAt: time(40) }], 'branch')
    expect(navigators.get('root')).toMatchObject({ index: 1, count: 2, nextBranchId: 'retry' })
    expect(navigators.has('reply')).toBe(false)
    expect(navigators.has('child')).toBe(false)
  })
})
