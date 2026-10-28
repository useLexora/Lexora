import type { LocalConversationTimelineItem } from '@buddy-shared/conversation/conversationApi'
import type { LocalExecutionInputReceipt } from '@buddy-shared/executions/executionInputReceipt'
import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { LocalRun } from '@buddy-shared/runs/runApi'
import type { ChatTranscriptMessageRow, ChatTranscriptRow } from '../chatTranscriptTypes'
import { describe, expect, it } from 'vitest'
import { projectExecutionGroups } from '../../executions/executionGroups'
import { projectChatAgentTurn } from '../chatAgentTurn'
import { projectChatExecutionInputRows } from '../chatExecutionInputRows'
import { projectChatMessageBranchNavigators } from '../chatMessageBranches'
import { presentChatTranscript } from '../chatTranscriptPresentation'
import { createChatTranscriptProjector, projectChatTranscript } from '../chatTranscriptProjection'

const time = (seconds: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, seconds)).toISOString()
function run(id: string, start: number, finish: number): LocalRun {
  return { id, buddyId: id, branchId: 'branch', conversationId: 'task', triggeringMessageId: `input-${id}`, status: 'completed', startedAt: time(start), completedAt: time(finish), approvalPolicy: 'policy', executionProfile: 'workspace_write', modelId: 'model', providerId: 'provider', purpose: 'chat', reasoningLevel: null, errorCode: null }
}
function execution(runId: string, rootRunId = runId, kind: LocalExecution['kind'] = runId === rootRunId ? 'root' : 'actor_child'): LocalExecution {
  return { runId, rootRunId, parentRunId: runId === rootRunId ? null : rootRunId, buddyId: runId, buddyName: runId, ordinal: null, kind, phase: 'closed', status: 'completed', startedAt: time(0), completedAt: time(40), updatedAt: time(40), progress: null, toolCount: 0, usage: null, stopping: false, task: 'Work', waitingFor: null, activeChildren: 0, canCancel: false, canAnswer: false, canSend: false, cleanup: 'clean', errorCode: null, affectedResources: [], questions: [] }
}
function message(id: string, seconds: number, runId: string | null = null): Extract<LocalConversationTimelineItem, { kind: 'message' }> {
  return { kind: 'message', id, role: runId ? 'assistant' : 'user', branchId: 'branch', conversationId: 'task', runId, attachments: [], content: { text: id }, createdAt: time(seconds) }
}
function receipt(runId: string, rootRunId: string, seconds: number): LocalExecutionInputReceipt {
  return { conversationId: 'task', branchId: 'branch', runId, rootRunId, buddyId: runId, buddyName: runId, task: 'Work', messageId: `receipt-${runId}`, text: 'Keep this private from other actors', kind: 'supplement', createdAt: time(seconds), state: 'pending' }
}

const a = run('a', 0, 40)
const b = run('b', 10, 20)
const groups = projectExecutionGroups([execution('a'), execution('a-child', 'a'), execution('npc', 'a', 'npc_child'), execution('b')])
const snapshot = {
  runs: [a, b],
  outputs: [],
  timelineItems: [message('input-a', 0), message('input-b', 10), message('reply-b', 19, 'b'), message('reply-a', 39, 'a-child')],
  executionGroups: groups,
}

describe('private input transcript receipts', () => {
  it('keeps late inputs in their actual root group and preserves the recipient reply and root result ownership', () => {
    const input = receipt('a-child', 'a', 35)
    const rows = projectChatTranscript({ ...snapshot, executionInputs: [input] }).rows
    expect(rows.map(row => row.key)).toEqual(['message:input-a', 'execution-input:receipt-a-child', 'message:reply-a', 'message:input-b', 'message:reply-b'])
    expect(rows[1]).toEqual({ kind: 'execution-input', key: 'execution-input:receipt-a-child', input })
    expect(rows[2]).toMatchObject({ kind: 'message', message: { runId: 'a-child', createdAt: time(39) }, turnResult: { runId: 'a' } })
    expect(rows[4]).toMatchObject({ kind: 'message', message: { runId: 'b' }, turnResult: { runId: 'b' } })
  })

  it('refreshes receipt state without changing the row key and excludes private or unknown recipients', () => {
    const projector = createChatTranscriptProjector()
    const input = receipt('a-child', 'a', 35)
    const cached = { ...snapshot, runProjections: snapshot.runs.map(run => ({ turn: projectChatAgentTurn(run, []), recoveryNotices: [], streamingMessages: [] })) }
    const first = projector.project({ ...cached, executionInputs: [input] })
    const updated = projector.project({ ...cached, executionInputs: [{ ...input, state: 'accepted' }] })
    expect(updated.rows.map(row => row.key)).toEqual(first.rows.map(row => row.key))
    expect(updated.rows.find(row => row.kind === 'execution-input')).toMatchObject({ input: { state: 'accepted' } })
    expect(projectChatTranscript({ ...snapshot, executionInputs: [receipt('npc', 'a', 35), receipt('unknown', 'a', 35)] }).rows).toEqual(projectChatTranscript(snapshot).rows)
  })

  it('does not attach results across a receipt or transfer child artifacts to the root or receipt', () => {
    const turn = projectChatAgentTurn(a, [])
    const reply: ChatTranscriptMessageRow = {
      kind: 'message',
      key: 'message:child',
      message: message('child', 10, 'a-child'),
      resultRunId: 'a-child',
      turnOutputs: { runId: 'a-child', artifacts: [{ artifactId: 'file', conversationId: 'task', runId: 'a-child', createdAt: time(10), updatedAt: time(10), kind: 'file', mimeType: 'text/plain', name: 'result.txt', path: '/workspace/result.txt', previewUrl: null, sizeBytes: 1, sourceArtifactId: null, sourceToolCallId: 'write' }] },
    }
    const rows: ChatTranscriptRow[] = [
      { kind: 'message', key: 'message:input-a', message: message('input-a', 0), turnOutputs: null },
      reply,
      { kind: 'turn-result', key: 'turn-result:a', turn },
    ]
    const presented = presentChatTranscript(projectChatExecutionInputRows(rows, [receipt('a-child', 'a', 20)], [turn], groups), groups).rows
    expect(presented.map(row => row.kind)).toEqual(['message', 'message', 'execution-input', 'turn-result'])
    expect(presented[1]).toMatchObject({ resultRunId: 'a-child', turnOutputs: reply.turnOutputs })
    expect(presented[1]).not.toHaveProperty('turnResult')
    const branch = { id: 'branch', conversationId: 'task', parentBranchId: null, forkedFromMessageId: null, createdAt: time(0) }
    const branches = projectChatMessageBranchNavigators(presented, [branch, { ...branch, id: 'retry', parentBranchId: 'branch', forkedFromMessageId: 'input-a', createdAt: time(50) }], 'branch')
    expect(branches.get('a')).toMatchObject({ count: 2, nextBranchId: 'retry' })
    expect(branches.has('receipt-a-child')).toBe(false)
  })
})
