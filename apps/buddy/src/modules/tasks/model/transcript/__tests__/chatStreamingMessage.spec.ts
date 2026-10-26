import type { LocalConversationTimelineItem } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'

import type { ChatAgentTurn } from '../chatStreamingMessage'
import { describe, expect, it } from 'vitest'

import { createChatAgentActivityProjector } from '../chatAgentActivities'
import { createChatAgentTurnReducer } from '../chatAgentTurn'
import {
  projectChatAgentTurns,
  projectChatRecoveryNotices,
  projectStreamingAssistantMessage,
} from '../chatStreamingMessage'
import { canExpandChatTool } from '../chatToolDisplay'
import {
  projectChatTranscript,
  projectPersistedChatTranscriptRows,
} from '../chatTranscriptProjection'

describe('projectStreamingAssistantMessage', () => {
  it('replays desktop panel actions as visible system records without model messages or tool counts', () => {
    const events = [
      event(1, 'desktop.panel.changed', { action: 'open', actor: 'harness' }),
      event(2, 'desktop.panel.changed', { action: 'close', actor: 'user' }),
    ]
    const [turn] = projectChatAgentTurns(events, [run('completed')])
    expect(turn?.nodes.map(node => ({ kind: node.kind, ...('action' in node ? { action: node.action, actor: node.actor } : {}) })))
      .toEqual([{ kind: 'panel', action: 'open', actor: 'harness' }, { kind: 'panel', action: 'close', actor: 'user' }])
    expect(createChatAgentActivityProjector().project(turn!.nodes)).toMatchObject([
      { kind: 'panel-group', actor: 'mixed', nodes: turn!.nodes },
    ])
    expect(projectStreamingAssistantMessage([], events, [run('completed')])).toBeNull()
    expect(turn?.processMessageIds).toEqual([])
  })

  it('keeps a completed event visible until its SQLite message arrives only within the loaded history', () => {
    const events = [event(1, 'message.completed', {
      content: { text: 'Final answer' },
      messageId: 'assistant-1',
      role: 'assistant',
      stopReason: 'completed',
    })]

    expect(projectStreamingAssistantMessage([], events, [run('completed')])).toBeNull()
    expect(projectStreamingAssistantMessage([message('message-1', 'user', 'Question')], events, [run('completed')])).toEqual({
      id: 'assistant-1',
      text: 'Final answer',
    })
  })

  it('keeps one activity tail when the streaming answer is still empty', () => {
    const projection = projectChatTranscript({
      outputs: [],
      runEvents: [
        event(1, 'message.started', {
          messageId: 'message-streaming',
          role: 'assistant',
        }),
      ],
      runs: [run('running')],
      timelineItems: [message('message-1', 'user', 'Check status')],
    })

    expect(projection.rows.map(row => row.kind)).toEqual([
      'message',
      'agent-turn',
      'activity',
    ])
  })

  it('projects recovery warnings only beside loaded triggering messages', () => {
    const triggeringMessage: LocalConversationTimelineItem = {
      attachments: [],
      branchId: 'branch-1',
      content: { text: 'Continue' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:00.000Z',
      id: 'message-1',
      kind: 'message',
      role: 'user',
      runId: 'run-1',
    }
    const degraded = event(2, 'session.recovery.degraded', {
      missingAttachmentCount: 2,
      recoveredImageCount: 1,
      source: 'sqlite',
    })

    expect(projectChatRecoveryNotices(
      [triggeringMessage],
      [degraded],
      [run('running')],
    )).toEqual([{
      createdAt: degraded.createdAt,
      missingAttachmentCount: 2,
      runId: 'run-1',
      sequence: 2,
    }])
    expect(projectChatRecoveryNotices([], [degraded], [run('running')])).toEqual([])
    expect(projectChatRecoveryNotices(
      [triggeringMessage],
      [{ ...degraded, payload: { missingAttachmentCount: 0 } }],
      [run('running')],
    )).toEqual([])
  })

  it('replays legacy narration and structured system results in order without duplicating the final answer', () => {
    const narration = 'I will inspect the process first.'
    const presentation = { action: 'terminate-process', card: 'system', description: null, output: null, status: 'running', target: null, truncated: false, verified: null }
    const turns = projectChatAgentTurns([
      event(1, 'message.started', { messageId: 'message-process', role: 'assistant' }),
      event(2, 'message.block.started', { contentIndex: 0, kind: 'reasoning', messageId: 'message-process' }),
      event(3, 'message.block.completed', { content: 'Checking the current process state', contentIndex: 0, kind: 'reasoning', messageId: 'message-process' }),
      event(4, 'message.completed', { content: { text: narration }, messageId: 'message-process', role: 'assistant', stopReason: 'tool_use' }),
      event(5, 'tool.started', { presentation, toolCallId: 'tool-action', toolName: 'lexora_system_action' }),
      event(6, 'tool.completed', { isError: false, presentation: { ...presentation, status: 'completed', target: 'fixture-process', verified: true }, toolCallId: 'tool-action', toolName: 'lexora_system_action' }),
      event(7, 'message.completed', { content: { text: 'The fixture process has stopped.' }, messageId: 'message-final', role: 'assistant', stopReason: 'completed' }),
      event(8, 'run.completed', {}),
    ], [run('completed')])

    expect(turns[0]).toMatchObject({
      finalMessageId: 'message-final',
      nodes: [
        { kind: 'reasoning', status: 'completed', text: 'Checking the current process state' },
        { kind: 'text', messageId: 'message-process', phase: 'commentary', text: narration },
        { kind: 'tool', description: null, status: 'completed', presentation: { card: 'system', action: 'terminate-process', target: 'fixture-process', verified: true } },
      ],
      processMessageIds: ['message-process'],
    })
    expect(projectPersistedChatTranscriptRows([
      message('message-1', 'user', 'Check the process'),
      message('message-process', 'assistant', narration),
      message('message-final', 'assistant', 'The fixture process has stopped.'),
    ], turns).map(row => row.key)).toEqual(['message:message-1', 'agent-turn:run-1', 'message:message-final', 'turn-result:run-1'])
  })

  it('projects phase-aware commentary as process text even when the response completes normally', () => {
    const events = [
      event(1, 'message.delta', {
        contentIndex: 0,
        delta: 'I found the target process and will verify its memory usage.',
        messageId: 'message-mixed',
        phase: 'commentary',
      }),
      event(2, 'message.block.completed', {
        content: 'I found the target process and will verify its memory usage.',
        contentIndex: 0,
        kind: 'text',
        messageId: 'message-mixed',
        phase: 'commentary',
      }),
      event(3, 'message.block.completed', {
        content: 'PID 42 is running and uses 6 MiB RSS.',
        contentIndex: 1,
        kind: 'text',
        messageId: 'message-mixed',
        phase: 'final_answer',
      }),
      event(4, 'message.completed', {
        content: { text: 'PID 42 is running and uses 6 MiB RSS.' },
        messageId: 'message-mixed',
        phase: 'final_answer',
        role: 'assistant',
        stopReason: 'completed',
      }),
    ]
    const turns = projectChatAgentTurns(events, [run('completed')])
    expect(projectStreamingAssistantMessage([], events.slice(0, 2), [run('running')])).toBeNull()
    expect(projectStreamingAssistantMessage([], [
      ...events.slice(0, 2),
      event(3, 'message.delta', { contentIndex: 1, delta: 'PID 42 is running and uses 6 MiB RSS.', messageId: 'message-mixed', phase: 'final_answer' }),
    ], [run('running')])).toEqual({ id: 'message-mixed', text: 'PID 42 is running and uses 6 MiB RSS.' })

    expect(turns[0]).toMatchObject({
      finalMessageId: 'message-mixed',
      nodes: [{
        kind: 'text',
        messageId: 'message-mixed',
        text: 'I found the target process and will verify its memory usage.',
      }],
      processMessageIds: [],
    })

    const user = message('message-1', 'user', 'Check the process')
    const final = message('message-mixed', 'assistant', 'PID 42 is running and uses 6 MiB RSS.')
    expect(projectPersistedChatTranscriptRows([user, final], turns).map(row => row.kind)).toEqual([
      'message',
      'agent-turn',
      'message',
      'turn-result',
    ])
  })

  it('projects the latest explicit progress phase only while the run is active', () => {
    const events = [
      event(1, 'run.progress', { phase: 'model_requesting', toolName: null }),
      event(2, 'run.progress', { phase: 'tool_executing', toolName: 'bash' }),
    ]

    expect(projectChatAgentTurns(events, [run('running')])[0]).toMatchObject({
      progress: { phase: 'tool_executing', toolName: 'bash' },
    })
    expect(projectChatAgentTurns(events, [run('completed')])[0]).toMatchObject({
      progress: null,
    })
  })

  it('projects the terminal model failure reason instead of ongoing activity', () => {
    expect(projectChatAgentTurns([
      event(1, 'run.failed', {
        errorCode: 'MODEL_REQUEST_FAILED',
        errorMessage: 'The configured model does not exist',
      }),
    ], [{
      ...run('failed'),
      completedAt: '2026-08-14T00:00:01.000Z',
      errorCode: 'MODEL_REQUEST_FAILED',
    }])).toEqual([expect.objectContaining({
      failureCode: 'MODEL_REQUEST_FAILED',
      failureMessage: 'The configured model does not exist',
      status: 'failed',
    })])
  })

  it('shows a real thinking start before content but does not retain empty terminal blocks', () => {
    const events = [event(1, 'message.block.started', { contentIndex: 0, kind: 'reasoning', messageId: 'thought' })]
    expect(projectChatAgentTurns([], [run('running')])[0]?.nodes).toEqual([])
    expect(projectChatAgentTurns(events, [run('running')])[0]?.nodes).toMatchObject([{ kind: 'reasoning', text: '', status: 'running' }])
    expect(projectChatAgentTurns(events, [run('cancelled')])[0]?.nodes).toEqual([])
    expect(projectChatAgentTurns([...events, event(2, 'message.block.completed', { contentIndex: 0, kind: 'reasoning', messageId: 'thought', content: '' })], [run('running')])[0]?.nodes).toEqual([])
  })

  it('settles thinking as text begins even when its end event is delayed, and resumes only on real reasoning', () => {
    const thought = [
      event(1, 'message.block.started', { contentIndex: 0, kind: 'reasoning', messageId: 'stream' }),
      event(2, 'message.block.delta', { contentIndex: 0, kind: 'reasoning', messageId: 'stream', delta: 'Checking' }),
    ]
    const responding = [...thought, event(3, 'message.delta', { contentIndex: 1, messageId: 'stream', delta: 'Answer' })]
    const reducer = createChatAgentTurnReducer(run('running'))
    reducer.append(thought)
    reducer.append([responding[2]!])
    expect(reducer.project().nodes).toMatchObject([{ status: 'completed', text: 'Checking' }])
    reducer.append([event(4, 'message.delta', { contentIndex: 1, messageId: 'stream', delta: ' continues' })])
    expect(reducer.project().nodes).toMatchObject([{ status: 'completed', text: 'Checking' }])
    expect(projectChatAgentTurns([...thought, event(3, 'run.progress', { phase: 'preparing', toolName: null })], [run('running')])[0]?.nodes).toMatchObject([{ status: 'completed' }])
    expect(projectChatAgentTurns([...thought, event(3, 'run.progress', { phase: 'preparing', toolName: 'read' })], [run('running')])[0]?.nodes).toMatchObject([{ status: 'running' }])
    expect(projectChatAgentTurns([...responding, event(4, 'message.block.delta', { contentIndex: 0, kind: 'reasoning', messageId: 'stream', delta: ' more' })], [run('running')])[0]?.nodes).toMatchObject([{ status: 'running', text: 'Checking more' }])
    expect(projectChatAgentTurns([...thought, event(3, 'message.block.started', { contentIndex: 1, kind: 'text', messageId: 'stream', phase: 'commentary' })], [run('running')])[0]?.nodes[0]).toMatchObject({ status: 'completed' })
  })

  it.each(['failed', 'length'])('retains interrupted thinking after a %s message while a retry waits', (stopReason) => {
    const events = [
      event(1, 'message.block.delta', { contentIndex: 0, kind: 'reasoning', messageId: 'attempt-1', delta: 'Partial thought' }),
      event(2, 'message.completed', { messageId: 'attempt-1', content: { text: '' }, stopReason }),
      event(3, 'run.progress', { phase: 'model_requesting', toolName: null, retry: { attempt: 1, maxAttempts: 3, retryAt: '2026-08-14T00:00:05Z' } }),
    ]
    expect(projectChatAgentTurns(events, [run('running')])[0]?.nodes).toMatchObject([{ status: 'interrupted', text: 'Partial thought' }])
    expect(projectChatAgentTurns(events, [run('cancelled')])[0]?.nodes).toMatchObject([{ status: 'interrupted', text: 'Partial thought' }])
    const next = [...events, event(4, 'message.block.delta', { contentIndex: 0, kind: 'reasoning', messageId: 'attempt-2', delta: 'Next thought' })]
    expect(projectChatAgentTurns(next, [run('running')])[0]?.nodes).toMatchObject([{ status: 'interrupted', text: 'Partial thought' }, { status: 'running', text: 'Next thought' }])
  })

  it('deduplicates tool-use narration that repeats reasoning', () => {
    const process = projectChatAgentTurns([
      event(1, 'message.block.started', {
        contentIndex: 0,
        kind: 'reasoning',
        messageId: 'message-process',
      }),
      event(2, 'message.block.completed', {
        content: '**Inspecting the current process state**',
        contentIndex: 0,
        kind: 'reasoning',
        messageId: 'message-process',
      }),
      event(3, 'message.completed', {
        content: { text: 'Inspecting the current process state' },
        messageId: 'message-process',
        role: 'assistant',
        stopReason: 'tool_use',
      }),
    ], [run('completed')])[0]

    expect(process?.nodes).toEqual([expect.objectContaining({
      kind: 'reasoning',
      text: '**Inspecting the current process state**',
    })])
  })

  it.each(['failed', 'cancelled'] as const)(
    'assigns %s result actions to the agent turn when its final message is empty',
    (status) => {
      const user = message('message-1', 'user', 'Check status')
      const emptyFinal = message('message-empty', 'assistant', '')
      const turn: ChatAgentTurn = {
        branchId: 'branch-1',
        completedAt: '2026-08-14T00:00:02.000Z',
        finalMessageId: emptyFinal.id,
        nodes: [],
        processMessageIds: [],
        usage: null,
        progress: null,
        reasoningLevel: null,
        runId: 'run-1',
        startedAt: '2026-08-14T00:00:00.000Z',
        status,
        triggeringMessageId: user.id,
      }

      expect(projectPersistedChatTranscriptRows([user, emptyFinal], [turn])).toEqual([
        expect.objectContaining({ key: `message:${user.id}`, kind: 'message' }),
        expect.objectContaining({
          key: `agent-turn:${turn.runId}`,
          kind: 'agent-turn',
          ownsResultActions: true,
        }),
      ])
    },
  )

  it('preserves a denied approval as a distinct tool outcome', () => {
    const turns = projectChatAgentTurns([
      event(1, 'approval.requested', {
        id: 'approval-1',
        kind: 'shell',
        review: {
          card: 'shell',
          command: 'systemctl restart example',
          toolName: 'bash',
        },
        status: 'pending',
        summary: 'Run a command',
        toolCallId: 'tool-1',
      }),
      event(2, 'approval.resolved', {
        id: 'approval-1',
        resolvedAt: '2026-08-14T00:00:02.000Z',
        status: 'denied',
      }),
      event(3, 'tool.completed', {
        isError: true,
        presentation: {
          card: 'terminal',
          command: 'systemctl restart example',
          cwd: '.',
          description: null,
          exitCode: null,
          output: 'APPROVAL_DENIED',
          signal: null,
          truncated: false,
        },
        toolCallId: 'tool-1',
        toolName: 'bash',
      }),
    ], [run('completed')])

    expect(turns[0]?.nodes).toEqual([
      expect.objectContaining({
        isError: true,
        status: 'denied',
        toolCallId: 'tool-1',
      }),
    ])
  })

  it('finalizes an awaiting tool when its run is cancelled before the approval event catches up', () => {
    const [turn] = projectChatAgentTurns([
      event(1, 'approval.requested', {
        id: 'approval-1',
        kind: 'shell',
        review: { card: 'shell', command: 'echo fixture', toolName: 'bash' },
        status: 'pending',
        summary: 'Run a command',
        toolCallId: 'tool-1',
      }),
    ], [run('cancelled')])
    expect(turn?.nodes).toEqual([expect.objectContaining({ kind: 'tool', status: 'interrupted', toolCallId: 'tool-1' })])
  })

  it('keeps pending approval visible despite late tool start and stale execution progress', () => {
    const turns = projectChatAgentTurns([
      event(1, 'approval.requested', {
        id: 'approval-1',
        kind: 'shell',
        review: {
          card: 'shell',
          command: 'systemctl restart example',
          toolName: 'bash',
        },
        status: 'pending',
        summary: 'Run a command',
        toolCallId: 'tool-1',
      }),
      event(2, 'tool.started', {
        presentation: {
          card: 'terminal',
          command: 'systemctl restart example',
          cwd: '.',
          description: null,
          exitCode: null,
          output: null,
          signal: null,
          truncated: false,
        },
        toolCallId: 'tool-1',
        toolName: 'bash',
      }),
      event(3, 'run.progress', { phase: 'tool_executing', toolName: 'bash' }),
    ], [run('running')])

    expect(turns[0]?.nodes).toEqual([
      expect.objectContaining({
        approvalId: 'approval-1',
        status: 'awaiting_approval',
        toolCallId: 'tool-1',
      }),
    ])
    expect(turns[0]?.progress).toEqual({ phase: 'awaiting_approval', toolName: 'bash' })
  })

  it('uses the structured approval target for a pending system action', () => {
    expect(projectChatAgentTurns([
      event(1, 'tool.started', {
        presentation: {
          action: 'terminate-process',
          card: 'system',
          description: 'Finish the disposable acceptance target',
          output: null,
          status: 'running',
          target: 'approved system target',
          truncated: false,
          verified: null,
        },
        toolCallId: 'tool-action',
        toolName: 'lexora_system_action',
      }),
      event(2, 'approval.requested', {
        id: 'approval-system',
        kind: 'system',
        review: {
          action: 'terminate-process',
          card: 'system-action',
          effect: 'Ask the process to exit gracefully',
          expiresAt: '2026-08-23T12:05:00.000Z',
          interruption: 'none',
          reason: 'Finish the disposable acceptance target',
          target: {
            displayName: 'buddy-act-test',
            pid: 8454,
            startedAt: '2026-08-23T12:00:00.000Z',
          },
          toolName: 'lexora_system_action',
        },
        status: 'pending',
        summary: 'Ask the process to exit gracefully: buddy-act-test',
        toolCallId: 'tool-action',
      }),
    ], [run('running')])[0]).toMatchObject({
      nodes: [{
        description: null,
        presentation: {
          action: 'terminate-process',
          description: null,
          status: 'awaiting-approval',
          target: 'buddy-act-test',
        },
        status: 'awaiting_approval',
      }],
    })
  })

  it('keeps a read-only policy denial attached to its tool row', () => {
    expect(projectChatAgentTurns([
      event(1, 'tool.preparing', {
        presentation: {
          card: 'diff',
          description: null,
          diff: null,
          firstChangedLine: null,
          operation: 'created',
          output: null,
          path: '/tmp/result.txt',
          truncated: false,
        },
        toolCallId: 'tool-1',
        toolName: 'write',
      }),
      event(2, 'tool.denied', {
        denialCode: 'READ_ONLY_PROFILE',
        toolCallId: 'tool-1',
        toolName: 'write',
      }),
      event(3, 'tool.completed', {
        isError: true,
        presentation: {
          card: 'diff',
          description: null,
          diff: null,
          firstChangedLine: null,
          operation: 'created',
          output: null,
          path: '/tmp/result.txt',
          truncated: false,
        },
        toolCallId: 'tool-1',
        toolName: 'write',
      }),
    ], [run('completed')])[0]).toMatchObject({
      nodes: [{
        denialCode: 'READ_ONLY_PROFILE',
        isError: true,
        status: 'denied',
        toolCallId: 'tool-1',
      }],
    })
  })

  it.each(['tool.failed', 'tool.denied'])('replays %s path failures with visible details in one issue group', (type) => {
    const presentations = [
      { card: 'read', description: null, language: null, lineStart: 1, path: 'missing.txt', output: 'PATH_NOT_FOUND', truncated: false },
      { card: 'search', description: null, glob: null, path: 'missing-directory', query: '', output: 'PATH_NOT_FOUND', truncated: false },
    ]
    const tools = ['read', 'ls']
    const events = presentations.flatMap((presentation, index) => {
      const tool = { toolCallId: `tool-${index}`, toolName: tools[index] }
      return [
        event(index * 3 + 1, 'tool.preparing', { ...tool, presentation: { ...presentation, output: null } }),
        event(index * 3 + 2, type, { ...tool, [type === 'tool.failed' ? 'errorCode' : 'denialCode']: 'PATH_NOT_FOUND' }),
        event(index * 3 + 3, 'tool.completed', { ...tool, isError: true, presentation }),
      ]
    })
    const turn = projectChatAgentTurns(events, [run('completed')])[0]!
    const nodes = turn.nodes.filter(node => node.kind === 'tool')
    expect(turn.status).toBe('completed')
    expect(nodes.map(node => [node.status, node.errorCode, node.denialCode])).toEqual([
      ['failed', 'PATH_NOT_FOUND', undefined],
      ['failed', 'PATH_NOT_FOUND', undefined],
    ])
    expect(nodes.every(node => canExpandChatTool(node))).toBe(true)
    const groups = createChatAgentActivityProjector().project(turn.nodes)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'activity-group', issueCount: 2, toolCount: 2 })
    const missingRead = nodes[0]!
    if (missingRead.presentation.card !== 'read')
      throw new Error('Expected a file-read presentation')
    expect(canExpandChatTool({ ...missingRead, presentation: { ...missingRead.presentation, output: null } }, () => true)).toBe(false)
  })

  it('marks unfinished automatic context compaction as interrupted with its run', () => {
    expect(projectChatAgentTurns([
      event(1, 'context.compaction.started', { reason: 'overflow' }),
    ], [run('failed')])[0]).toMatchObject({
      nodes: [{
        estimatedTokensAfter: null,
        kind: 'compaction',
        status: 'interrupted',
        tokensBefore: null,
      }],
    })
  })
})

function run(status: LocalRun['status']): LocalRun {
  return {
    buddyId: 'default',
    branchId: 'branch-1',
    completedAt: status === 'completed' ? '2026-08-14T00:00:02.000Z' : null,
    conversationId: 'conversation-1',
    errorCode: null,
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write',
    id: 'run-1',
    modelId: 'model-1',
    providerId: 'provider-1',
    purpose: 'chat',
    reasoningLevel: null,
    startedAt: '2026-08-14T00:00:00.000Z',
    status,
    triggeringMessageId: 'message-1',
  }
}

function event(sequence: number, type: string, payload: LocalRunEvent['payload']): LocalRunEvent {
  return {
    createdAt: `2026-08-14T00:00:0${sequence}.000Z`,
    payload,
    runId: 'run-1',
    sequence,
    type,
  }
}

function message(
  id: string,
  role: 'assistant' | 'user',
  text: string,
): Extract<LocalConversationTimelineItem, { kind: 'message' }> {
  return {
    attachments: [],
    branchId: 'branch-1',
    content: { text },
    conversationId: 'conversation-1',
    createdAt: '2026-08-14T00:00:00.000Z',
    id,
    kind: 'message',
    role,
    runId: role === 'assistant' ? 'run-1' : null,
  }
}
