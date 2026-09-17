import type { LocalConversationTimelineItem } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'

import type { ChatAgentTurn } from '../chatStreamingMessage'
import { describe, expect, it } from 'vitest'

import { createChatAgentActivityProjector } from '../chatAgentActivities'
import * as chatProjections from '../chatStreamingMessage'
import { canExpandChatTool, describeChatTool } from '../chatToolDisplay'
import {
  projectChatTranscript,
  projectPersistedChatTranscriptRows,
} from '../chatTranscriptProjection'

const {
  projectChatAgentTurns,
  projectChatRecoveryNotices,
  projectStreamingAssistantMessage,
} = chatProjections

describe('projectStreamingAssistantMessage', () => {
  it('replays desktop panel actions as visible system records without model messages or tool counts', () => {
    const events = [
      event(1, 'desktop.panel.changed', { action: 'open', actor: 'harness' }),
      event(2, 'desktop.panel.changed', { action: 'close', actor: 'user' }),
    ]
    const [turn] = projectChatAgentTurns(events, [run('completed')])
    expect(turn?.nodes.map(node => ({ kind: node.kind, ...('action' in node ? { action: node.action, actor: node.actor } : {}) })))
      .toEqual([{ kind: 'panel', action: 'open', actor: 'harness' }, { kind: 'panel', action: 'close', actor: 'user' }])
    expect(createChatAgentActivityProjector().project(turn!.nodes).map(row => row.kind)).toEqual(['panel', 'panel'])
    expect(projectStreamingAssistantMessage([], events, [run('completed')])).toBeNull()
    expect(turn?.processMessageIds).toEqual([])
  })

  it('does not resurrect a completed message from a terminal run outside the message page', () => {
    const events = [event(1, 'message.completed', {
      content: { text: 'Old completed answer' },
      messageId: 'old-message',
      role: 'assistant',
    })]

    expect(projectStreamingAssistantMessage([], events, [run('completed')])).toBeNull()
  })

  it('keeps a completed event visible while its loaded trigger awaits the SQLite message', () => {
    const events = [event(1, 'message.completed', {
      content: { text: 'Final answer' },
      messageId: 'assistant-1',
      role: 'assistant',
      stopReason: 'completed',
    })]

    expect(projectStreamingAssistantMessage([{
      attachments: [],
      branchId: 'branch-1',
      content: { text: 'Question' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:00.000Z',
      id: 'message-1',
      role: 'user',
      runId: null,
    }], events, [run('completed')])).toEqual({
      id: 'assistant-1',
      text: 'Final answer',
    })
  })

  it('keeps commentary out of the streaming final answer surface', () => {
    const commentary = [
      event(1, 'message.started', { messageId: 'message-commentary', role: 'assistant' }),
      event(2, 'message.delta', {
        contentIndex: 0,
        delta: 'I am checking the process now.',
        messageId: 'message-commentary',
        phase: 'commentary',
      }),
    ]
    const finalAnswer = [
      event(1, 'message.started', { messageId: 'message-final', role: 'assistant' }),
      event(2, 'message.delta', {
        contentIndex: 0,
        delta: 'The process is running.',
        messageId: 'message-final',
        phase: 'final_answer',
      }),
    ]

    expect(projectStreamingAssistantMessage([], commentary, [run('running')])).toBeNull()
    expect(projectStreamingAssistantMessage([], finalAnswer, [run('running')])).toEqual({
      id: 'message-final',
      text: 'The process is running.',
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

  it('projects a flat agent turn and attaches narration to the following tool', () => {
    const turns = projectChatAgentTurns([
      event(1, 'message.started', { messageId: 'message-process', role: 'assistant' }),
      event(2, 'message.block.started', {
        contentIndex: 0,
        kind: 'reasoning',
        messageId: 'message-process',
      }),
      event(3, 'message.block.completed', {
        content: 'Checking the current process state',
        contentIndex: 0,
        kind: 'reasoning',
        messageId: 'message-process',
      }),
      event(4, 'message.completed', {
        content: { text: 'I will inspect the process first.' },
        messageId: 'message-process',
        role: 'assistant',
        stopReason: 'tool_use',
      }),
      event(5, 'tool.started', {
        presentation: {
          card: 'terminal',
          command: 'pgrep -a -f fixture-daemon',
          cwd: '.',
          description: 'Run a host shell command from the current workspace',
          exitCode: null,
          output: null,
          signal: null,
          truncated: false,
        },
        toolCallId: 'tool-1',
        toolName: 'bash',
      }),
      event(6, 'tool.completed', {
        isError: false,
        presentation: {
          card: 'terminal',
          command: 'pgrep -a -f fixture-daemon',
          cwd: '.',
          description: null,
          exitCode: 0,
          output: '',
          signal: null,
          truncated: false,
        },
        toolCallId: 'tool-1',
        toolName: 'bash',
      }),
      event(7, 'message.completed', {
        content: { text: 'The fixture daemon is not running.' },
        messageId: 'message-final',
        role: 'assistant',
        stopReason: 'completed',
      }),
      event(8, 'run.completed', {}),
    ], [{ ...run('completed'), reasoningLevel: 'high' }])

    expect(turns).toEqual([{
      branchId: 'branch-1',
      completedAt: '2026-08-14T00:00:02.000Z',
      finalMessageId: 'message-final',
      messageStartedAt: { 'message-process': '2026-08-14T00:00:01.000Z' },
      nodeStartedAt: { 'reasoning:message-process:0': '2026-08-14T00:00:02.000Z', 'tool:tool-1': '2026-08-14T00:00:05.000Z' },
      nodes: [
        {
          contentIndex: 0,
          id: 'reasoning:message-process:0',
          kind: 'reasoning',
          status: 'completed',
          text: 'Checking the current process state',
        },
        {
          description: 'I will inspect the process first.',
          id: 'tool:tool-1',
          isError: false,
          kind: 'tool',
          presentation: {
            card: 'terminal',
            command: 'pgrep -a -f fixture-daemon',
            cwd: '.',
            description: null,
            exitCode: 0,
            output: '',
            signal: null,
            truncated: false,
          },
          status: 'completed',
          toolCallId: 'tool-1',
          toolName: 'bash',
        },
      ],
      processMessageIds: ['message-process'],
      usage: null,
      progress: null,
      reasoningLevel: 'high',
      runId: 'run-1',
      startedAt: '2026-08-14T00:00:00.000Z',
      status: 'completed',
      triggeringMessageId: 'message-1',
    }])

    expect(projectPersistedChatTranscriptRows([
      message('message-1', 'user', 'Check the process'),
      message('message-process', 'assistant', 'I will inspect the process first.'),
      message('message-final', 'assistant', 'The fixture daemon is not running.'),
    ], turns).map(row => row.key)).toEqual([
      'message:message-1',
      'agent-turn:run-1',
      'message:message-final',
    ])
  })

  it('projects phase-aware commentary as process text even when the response completes normally', () => {
    const turns = projectChatRunProcessesForTest([
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
    ], [run('completed')]) as ReadonlyArray<ChatAgentTurn>

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

  it('removes empty reasoning blocks and duplicate tool-use narration', () => {
    const process = projectChatRunProcessesForTest([
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
      event(4, 'message.block.started', {
        contentIndex: 1,
        kind: 'reasoning',
        messageId: 'message-empty',
      }),
      event(5, 'message.block.completed', {
        content: '',
        contentIndex: 1,
        kind: 'reasoning',
        messageId: 'message-empty',
      }),
    ], [run('completed')])[0] as { nodes?: ReadonlyArray<unknown> } | undefined

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
    const turns = projectChatRunProcessesForTest([
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
    ], [run('completed')]) as ReadonlyArray<ChatAgentTurn>

    expect(turns[0]?.nodes).toEqual([
      expect.objectContaining({
        isError: true,
        status: 'denied',
        toolCallId: 'tool-1',
      }),
    ])
  })

  it('does not let a late tool start overwrite a pending approval', () => {
    const turns = projectChatRunProcessesForTest([
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
    ], [run('running')]) as ReadonlyArray<ChatAgentTurn>

    expect(turns[0]?.nodes).toEqual([
      expect.objectContaining({
        approvalId: 'approval-1',
        status: 'awaiting_approval',
        toolCallId: 'tool-1',
      }),
    ])
  })

  it('keeps the run activity in awaiting approval despite a stale executing event', () => {
    const turns = projectChatRunProcessesForTest([
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
      event(2, 'run.progress', { phase: 'tool_executing', toolName: 'bash' }),
    ], [run('running')]) as ReadonlyArray<ChatAgentTurn>

    expect(turns[0]?.progress).toEqual({
      phase: 'awaiting_approval',
      toolName: 'bash',
    })
  })

  it('keeps system tool rows structured instead of consuming model narration', () => {
    const narration = '温和结束 buddy-act-test 测试进程，不强制终止。'
    expect(projectChatAgentTurns([
      event(1, 'message.completed', {
        content: { text: narration },
        messageId: 'message-process',
        role: 'assistant',
        stopReason: 'tool_use',
      }),
      event(2, 'tool.started', {
        presentation: {
          action: 'terminate-process',
          card: 'system',
          description: null,
          output: null,
          status: 'running',
          target: null,
          truncated: false,
          verified: null,
        },
        toolCallId: 'tool-action',
        toolName: 'lexora_system_action',
      }),
      event(3, 'tool.completed', {
        isError: false,
        presentation: {
          action: 'terminate-process',
          card: 'system',
          description: null,
          output: null,
          status: 'completed',
          target: 'buddy-act-test',
          truncated: false,
          verified: true,
        },
        toolCallId: 'tool-action',
        toolName: 'lexora_system_action',
      }),
    ], [run('completed')])[0]).toMatchObject({
      nodes: [
        {
          kind: 'text',
          text: narration,
        },
        {
          description: null,
          kind: 'tool',
          presentation: {
            action: 'terminate-process',
            status: 'completed',
            target: 'buddy-act-test',
          },
        },
      ],
    })
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

  it('projects automatic context compaction as one lifecycle event', () => {
    expect(projectChatRunProcessesForTest([
      event(1, 'context.compaction.started', { reason: 'overflow' }),
      event(2, 'context.compaction.completed', {
        estimatedTokensAfter: 24_000,
        reason: 'overflow',
        tokensBefore: 292_000,
        willRetry: false,
      }),
    ], [run('completed')])[0]).toMatchObject({
      nodes: [{
        estimatedTokensAfter: 24_000,
        id: 'compaction:run-1:1',
        kind: 'compaction',
        status: 'completed',
        tokensBefore: 292_000,
      }],
    })
  })

  it('keeps a read-only policy denial attached to its tool row', () => {
    expect(projectChatRunProcessesForTest([
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
    expect(nodes.map(node => describeChatTool(node, 'zh-CN').status)).toEqual(['文件不存在', '目录不存在'])
    expect(nodes.map(node => describeChatTool(node, 'en-US').status)).toEqual(['File not found', 'Directory not found'])
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
    expect(projectChatRunProcessesForTest([
      event(1, 'context.compaction.started', { reason: 'overflow' }),
    ], [run('failed')])[0]).toMatchObject({
      nodes: [{
        estimatedTokensAfter: null,
        id: 'compaction:run-1:1',
        kind: 'compaction',
        status: 'interrupted',
        tokensBefore: null,
      }],
    })
  })
})

function run(status: LocalRun['status']): LocalRun {
  return {
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
): LocalConversationTimelineItem {
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

function projectChatRunProcessesForTest(
  events: ReadonlyArray<LocalRunEvent>,
  runs: ReadonlyArray<LocalRun>,
): ReadonlyArray<unknown> {
  return projectChatAgentTurns(events, runs)
}
