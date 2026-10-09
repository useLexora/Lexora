import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalConversationTimelineItem, LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunEvent, LocalRunOutput } from '@buddy-shared/runs/runApi'

import type { ChatRunTranscriptProjection } from '../chatRunTranscriptProjector'
import type { ChatAgentTurn } from '../chatStreamingMessage'
import { describe, expect, it } from 'vitest'

import { replaceChatRunEventBuckets } from '../../runs/chatRunEventBuckets'
import { createChatRunTranscriptProjector } from '../chatRunTranscriptProjector'
import {
  createChatTranscriptProjector,
  projectChatTranscript,
  projectPersistedChatTranscriptRows,
} from '../chatTranscriptProjection'

describe('chat transcript projection', () => {
  it('keeps legacy retry attempts chronological when run snapshots arrive newest first', () => {
    const user = message('retry-question', 'user')
    const cancelled = { ...localRun('old-run', user.id, 'cancelled'), completedAt: '2026-08-20T00:00:03.000Z' }
    const retry = { ...localRun('new-run', user.id, 'running'), startedAt: '2026-08-20T00:00:04.000Z' }
    const oldProjection = runProjection(agentTurn(cancelled, ['First attempt']))
    const activeProjection = runProjection(agentTurn(retry, ['Retry attempt']))
    const input = {
      outputs: [],
      runs: [retry, cancelled],
      timelineItems: [user],
      runProjections: [activeProjection, oldProjection],
    }
    const projector = createChatTranscriptProjector()
    const initial = projector.project(input)
    expect(initial.rows.map(row => row.key)).toEqual([
      'message:retry-question',
      'agent-turn:old-run',
      'agent-turn:new-run',
      'activity:new-run',
    ])
    expect(initial.rows.filter(row => row.kind === 'agent-turn').map(row => row.turn.status))
      .toEqual(['cancelled', 'running'])
    const updatedInput = { ...input, runProjections: [runProjection(agentTurn(retry, ['Retry progresses'])), oldProjection] }
    expect(projector.project(updatedInput).rows).toEqual(projectChatTranscript(updatedInput).rows)
    expect(projector.project(updatedInput).rows[1]).toBe(initial.rows[1])
  })

  it.each([false, true])('reuses historical rows as the active run advances with a background action: %s', (backgroundAction) => {
    const historyUser = message('history-user', 'user')
    const historyAssistant = {
      ...message('history-assistant', 'assistant'),
      runId: 'run-history',
    }
    const activeUser = message('active-user', 'user')
    const historyRun = localRun('run-history', historyUser.id, 'completed')
    const activeRun = localRun('run-active', activeUser.id, 'running')
    const historyProjection = runProjection(
      agentTurn(historyRun, [], historyAssistant.id),
    )
    const initialActiveProjection = runProjection(
      agentTurn(activeRun, ['Inspecting']),
      streamingMessage(activeRun, 'Working'),
    )
    const timelineItems: LocalConversationTimelineItem[] = [historyUser, historyAssistant, activeUser]
    if (backgroundAction) {
      timelineItems.push({ kind: 'extension-action', id: 'background', conversationId: activeRun.conversationId, branchId: activeRun.branchId, sourceMessageId: activeUser.id, extensionId: 'tests.title', extensionName: 'Title', actionId: 'tests.title.generate', title: 'Generate title', trigger: 'task:input:committed', status: 'running', message: null, createdAt: activeRun.startedAt, completedAt: null })
    }
    const runs = [historyRun, activeRun]
    const outputs: ReadonlyArray<LocalRunOutput> = []
    const projector = createChatTranscriptProjector()
    const initial = projector.project({
      outputs,
      runProjections: [historyProjection, initialActiveProjection],
      runs,
      timelineItems,
    })
    const updatedActiveProjection = runProjection(
      agentTurn(activeRun, ['Inspecting files']),
      streamingMessage(activeRun, 'Working now'),
    )

    const updated = projector.project({
      outputs,
      runProjections: [historyProjection, updatedActiveProjection],
      runs,
      timelineItems,
    })
    const rebuilt = projectChatTranscript({
      outputs,
      runProjections: [historyProjection, updatedActiveProjection],
      runs,
      timelineItems,
    })

    expect(updated.rows).toEqual(rebuilt.rows)
    expect(updated.update.kind).toBe(backgroundAction ? 'replace' : 'patch')
    expect(updated.rows.map(row => row.key)).toEqual(initial.rows.map(row => row.key))
    expect(updated.rows[0]).toBe(initial.rows[0])
    expect(updated.rows[1]).toBe(initial.rows[1])
    expect(updated.rows[2]).toBe(initial.rows[2])
    expect(updated.rows[3]).not.toBe(initial.rows[3])
    expect(updated.rows[4]).not.toBe(initial.rows[4])
    expect(updated.rows[5]).not.toBe(initial.rows[5])
  })

  it('uses cached run projections for streaming messages and recovery notices', () => {
    const user = message('message-run-1', 'user')
    const activeRun: LocalRun = {
      branchId: 'branch-1',
      completedAt: null,
      conversationId: 'conversation-1',
      errorCode: null,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'run-1',
      modelId: 'model-1',
      providerId: 'provider-1',
      purpose: 'chat',
      reasoningLevel: null,
      startedAt: '2026-08-20T00:00:00.000Z',
      status: 'running',
      triggeringMessageId: user.id,
    }
    const events = [
      runEvent(1, 'session.recovery.degraded', { missingAttachmentCount: 2 }),
      runEvent(2, 'message.started', {
        messageId: 'assistant-streaming',
        role: 'assistant',
      }),
      runEvent(3, 'message.delta', {
        delta: '缓存中的流式回复',
        messageId: 'assistant-streaming',
      }),
    ]
    const runProjections = createChatRunTranscriptProjector().project(
      replaceChatRunEventBuckets(events),
      [activeRun],
    )

    const projection = projectChatTranscript({
      outputs: [],
      runEvents: [],
      runProjections,
      runs: [activeRun],
      timelineItems: [user],
    } as Parameters<typeof projectChatTranscript>[0] & { runProjections: typeof runProjections })

    expect(projection.rows.map(row => row.kind)).toEqual([
      'message',
      'agent-turn',
      'recovery-notice',
      'message',
      'activity',
    ])
    expect(projection.rows[2]).toMatchObject({
      notice: { missingAttachmentCount: 2 },
    })
    expect(projection.rows[3]).toMatchObject({
      message: { content: { text: '缓存中的流式回复' } },
      streaming: true,
    })
  })

  it('shows completed turns only when they contain process nodes', () => {
    const user = message('user-1', 'user')
    const assistant = message('assistant-1', 'assistant')
    const emptyTurn: ChatAgentTurn = {
      branchId: 'branch-1',
      completedAt: '2026-08-20T00:00:01.000Z',
      finalMessageId: assistant.id,
      nodes: [],
      processMessageIds: [],
      usage: null,
      progress: null,
      reasoningLevel: null,
      runId: 'run-1',
      startedAt: '2026-08-20T00:00:00.000Z',
      status: 'completed',
      triggeringMessageId: user.id,
    }
    const reasoningTurn: ChatAgentTurn = {
      ...emptyTurn,
      nodes: [{
        contentIndex: 0,
        id: 'reasoning-1',
        kind: 'reasoning',
        status: 'completed',
        text: '分析问题',
      }],
    }

    expect(projectPersistedChatTranscriptRows([user, assistant], [emptyTurn])).toEqual([
      {
        key: `message:${user.id}`,
        kind: 'message',
        message: user,
        turnOutputs: null,
      },
      {
        resultRunId: 'run-1',
        key: `message:${assistant.id}`,
        kind: 'message',
        message: assistant,
        turnOutputs: null,
      },
    ])
    expect(projectPersistedChatTranscriptRows([user, assistant], [reasoningTurn])).toEqual([
      {
        key: `message:${user.id}`,
        kind: 'message',
        message: user,
        turnOutputs: null,
      },
      { key: `agent-turn:${reasoningTurn.runId}`, kind: 'agent-turn', turn: reasoningTurn },
      {
        showIdentity: false,
        resultRunId: 'run-1',
        key: `message:${assistant.id}`,
        kind: 'message',
        message: assistant,
        turnOutputs: null,
      },
    ])
  })

  it('keeps no-op compaction feedback out of transcript rows', () => {
    const noOpCompaction: Extract<LocalConversationTimelineItem, { kind: 'compaction' }> = {
      branchId: 'branch-1',
      completedAt: '2026-08-20T00:00:02.000Z',
      conversationId: 'conversation-1',
      createdAt: '2026-08-20T00:00:01.000Z',
      errorCode: 'CONTEXT_COMPACTION_NOT_NEEDED',
      estimatedTokensAfter: null,
      id: 'compaction-1',
      kind: 'compaction',
      status: 'failed',
      tokensBefore: null,
    }

    expect(projectPersistedChatTranscriptRows(
      [message('user-1', 'user'), noOpCompaction],
      [],
    ).map(row => row.kind)).toEqual(['message'])
  })

  it('keeps the same message row identity from streaming through persistence', () => {
    const user = message('user-1', 'user')
    const activeRun: LocalRun = {
      branchId: 'branch-1',
      completedAt: null,
      conversationId: 'conversation-1',
      errorCode: null,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      id: 'run-1',
      modelId: 'model-1',
      providerId: 'provider-1',
      purpose: 'chat',
      reasoningLevel: null,
      startedAt: '2026-08-20T00:00:00.000Z',
      status: 'running',
      triggeringMessageId: user.id,
    }
    const events: LocalRunEvent[] = [
      runEvent(1, 'message.started', {
        messageId: 'assistant-stable',
        role: 'assistant',
      }),
      runEvent(2, 'message.delta', {
        delta: '正在生成',
        messageId: 'assistant-stable',
      }),
    ]

    const streaming = projectChatTranscript({
      outputs: [],
      runEvents: events,
      runs: [activeRun],
      timelineItems: [user],
    }).rows.find(row => row.key === 'message:assistant-stable')
    const completed = projectChatTranscript({
      outputs: [],
      runEvents: [...events, runEvent(3, 'message.completed', {
        content: { text: '已经完成' },
        messageId: 'assistant-stable',
        role: 'assistant',
        stopReason: 'completed',
      })],
      runs: [{
        ...activeRun,
        completedAt: '2026-08-20T00:00:03.000Z',
        status: 'completed',
      }],
      timelineItems: [user, {
        ...message('assistant-stable', 'assistant'),
        content: { text: '已经完成' },
      }],
    }).rows.find(row => row.key === 'message:assistant-stable')

    expect(streaming).toMatchObject({
      key: 'message:assistant-stable',
      kind: 'message',
      streaming: true,
    })
    expect(completed).toMatchObject({
      key: 'message:assistant-stable',
      kind: 'message',
    })
    expect(completed).not.toHaveProperty('streaming')
  })

  it('attaches run outputs to the final result instead of projecting an output message', () => {
    const user = message('user-1', 'user')
    const final = message('assistant-final', 'assistant')
    const turn: ChatAgentTurn = {
      branchId: 'branch-1',
      completedAt: '2026-08-20T00:00:03.000Z',
      finalMessageId: final.id,
      nodes: [],
      processMessageIds: [],
      usage: null,
      progress: null,
      reasoningLevel: null,
      runId: 'run-1',
      startedAt: '2026-08-20T00:00:01.000Z',
      status: 'completed',
      triggeringMessageId: user.id,
    }

    const rows = projectPersistedChatTranscriptRows([user, final], [turn], [{
      artifacts: [{
        artifactId: 'generated-image-1',
        conversationId: 'conversation-1',
        createdAt: '2026-08-20T00:00:02.000Z',
        kind: 'file',
        mimeType: 'image/png',
        name: 'generated-image.png',
        path: '/workspace/generated-image.png',
        previewUrl: null,
        runId: 'run-1',
        sizeBytes: 12_345,
        sourceArtifactId: null,
        sourceToolCallId: 'tool-image-1',
        updatedAt: '2026-08-20T00:00:02.000Z',
      }],
      createdAt: '2026-08-20T00:00:02.000Z',
      runId: 'run-1',
      sourceToolCallId: 'tool-image-1',
    }])

    expect(rows).toEqual([
      {
        key: 'message:user-1',
        kind: 'message',
        message: user,
        turnOutputs: null,
      },
      {
        resultRunId: 'run-1',
        key: 'message:assistant-final',
        kind: 'message',
        message: final,
        turnOutputs: {
          artifacts: [{
            artifactId: 'generated-image-1',
            conversationId: 'conversation-1',
            createdAt: '2026-08-20T00:00:02.000Z',
            kind: 'file',
            mimeType: 'image/png',
            name: 'generated-image.png',
            path: '/workspace/generated-image.png',
            previewUrl: null,
            runId: 'run-1',
            sizeBytes: 12_345,
            sourceArtifactId: null,
            sourceToolCallId: 'tool-image-1',
            updatedAt: '2026-08-20T00:00:02.000Z',
          }],
          runId: 'run-1',
        },
      },
    ])
  })

  it('attaches the run change summary only to the final assistant result', () => {
    const user = message('user-1', 'user')
    const final = message('assistant-final', 'assistant')
    const turn: ChatAgentTurn = {
      branchId: 'branch-1',
      completedAt: '2026-08-20T00:00:03.000Z',
      finalMessageId: final.id,
      nodes: [],
      processMessageIds: [],
      usage: null,
      progress: null,
      reasoningLevel: null,
      runId: 'run-1',
      startedAt: '2026-08-20T00:00:01.000Z',
      status: 'completed',
      triggeringMessageId: user.id,
    }
    const changeSet: LocalChangeSetSummary = {
      changeSetId: 'changes-1',
      conversationId: 'conversation-1',
      coverage: 'complete',
      fileCount: 2,
      runId: 'run-1',
      status: 'completed',
      updatedAt: '2026-08-20T00:00:03.000Z',
    }

    const rows = projectPersistedChatTranscriptRows(
      [user, final],
      [turn],
      [],
      [changeSet],
    )

    expect(rows[0]).not.toHaveProperty('turnChanges')
    expect(rows[1]).toMatchObject({
      message: { id: final.id },
      turnChanges: changeSet,
    })
  })

  it('omits an empty run change summary from the final assistant result', () => {
    const user = message('user-1', 'user')
    const final = message('assistant-final', 'assistant')
    const turn: ChatAgentTurn = {
      branchId: 'branch-1',
      completedAt: '2026-08-20T00:00:03.000Z',
      finalMessageId: final.id,
      nodes: [],
      processMessageIds: [],
      usage: null,
      progress: null,
      reasoningLevel: null,
      runId: 'run-1',
      startedAt: '2026-08-20T00:00:01.000Z',
      status: 'completed',
      triggeringMessageId: user.id,
    }
    const emptyChangeSet: LocalChangeSetSummary = {
      changeSetId: 'changes-1',
      conversationId: 'conversation-1',
      coverage: 'partial',
      fileCount: 0,
      runId: 'run-1',
      status: 'completed',
      updatedAt: '2026-08-20T00:00:03.000Z',
    }

    const rows = projectPersistedChatTranscriptRows(
      [user, final],
      [turn],
      [],
      [emptyChangeSet],
    )

    expect(rows[1]).not.toHaveProperty('turnChanges')
  })
})

function runEvent(
  sequence: number,
  type: string,
  payload: LocalRunEvent['payload'],
): LocalRunEvent {
  return {
    createdAt: `2026-08-20T00:00:0${sequence}.000Z`,
    payload,
    runId: 'run-1',
    sequence,
    type,
  }
}

function message(
  id: string,
  role: 'assistant' | 'user',
): Extract<LocalConversationTimelineItem, { kind: 'message' }> {
  return {
    attachments: [],
    branchId: 'branch-1',
    content: { text: id },
    conversationId: 'conversation-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    id,
    kind: 'message',
    role,
    runId: role === 'assistant' ? 'run-1' : null,
  }
}

function localRun(
  id: string,
  triggeringMessageId: string,
  status: LocalRun['status'],
): LocalRun {
  return {
    branchId: 'branch-1',
    completedAt: status === 'completed' ? '2026-08-20T00:00:03.000Z' : null,
    conversationId: 'conversation-1',
    errorCode: null,
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write',
    id,
    modelId: 'model-1',
    providerId: 'provider-1',
    purpose: 'chat',
    reasoningLevel: null,
    startedAt: '2026-08-20T00:00:01.000Z',
    status,
    triggeringMessageId,
  }
}

function agentTurn(
  run: LocalRun,
  reasoning: ReadonlyArray<string>,
  finalMessageId: string | null = null,
): ChatAgentTurn {
  return {
    branchId: run.branchId,
    completedAt: run.completedAt,
    finalMessageId,
    nodes: reasoning.map((text, index) => ({
      contentIndex: index,
      id: `reasoning:${run.id}:${index}`,
      kind: 'reasoning',
      status: run.status === 'running' ? 'running' : 'completed',
      text,
    })),
    processMessageIds: [],
    usage: null,
    progress: null,
    reasoningLevel: run.reasoningLevel,
    runId: run.id,
    startedAt: run.startedAt,
    status: run.status,
    triggeringMessageId: run.triggeringMessageId,
  }
}

function runProjection(
  turn: ChatAgentTurn,
  streaming?: LocalMessage,
): ChatRunTranscriptProjection {
  return {
    recoveryNotices: [],
    streamingMessages: streaming
      ? [{
          message: streaming,
          orderCreatedAt: streaming.createdAt,
          orderSequence: 1,
          text: streaming.content !== null
            && typeof streaming.content === 'object'
            && 'text' in streaming.content
            ? String(streaming.content.text)
            : '',
        }]
      : [],
    turn,
  }
}

function streamingMessage(run: LocalRun, text: string): LocalMessage {
  return {
    attachments: [],
    branchId: run.branchId,
    content: { text },
    conversationId: run.conversationId,
    createdAt: '2026-08-20T00:00:02.000Z',
    id: `streaming:${run.id}`,
    role: 'assistant',
    runId: run.id,
  }
}
