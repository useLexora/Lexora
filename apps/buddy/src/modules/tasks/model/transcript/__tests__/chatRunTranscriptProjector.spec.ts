import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'

import { describe, expect, it } from 'vitest'
import {
  mergeChatRunEventBuckets,
  replaceChatRunEventBuckets,
} from '../../runs/chatRunEventBuckets'
import { createChatRunTranscriptProjector } from '../chatRunTranscriptProjector'

describe('chat run transcript projector', () => {
  it('refreshes usage when another model call completes and preserves it on terminal replay', () => {
    const running = run('run-a')
    const projector = createChatRunTranscriptProjector()
    const event = messageEvent('run-a', 1, 'usage.recorded', {
      usageRecordId: 'usage-a',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    })
    const buckets = replaceChatRunEventBuckets([event])
    const initial = projector.project(buckets, [running])[0]!
    const updatedBuckets = mergeChatRunEventBuckets(buckets, [messageEvent('run-a', 2, 'usage.recorded', {
      usageRecordId: 'usage-b',
      inputTokens: 50,
      outputTokens: 30,
      cacheReadTokens: 120,
      cacheWriteTokens: 10,
    })])
    const updated = projector.project(updatedBuckets, [running])[0]!
    expect(initial.turn.usage?.outputTokens).toBe(20)
    expect(updated.turn.usage).toEqual({ inputTokens: 150, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 10 })
    const terminal = projector.project(updatedBuckets, [{ ...running, status: 'completed' }])[0]!
    expect(terminal.turn.usage).toEqual(updated.turn.usage)
  })

  it('reuses the complete projection for an unaffected run', () => {
    const runA = run('run-a')
    const runB = run('run-b')
    const runAEvents = [
      reasoningEvent('run-a', 1, 'A'),
      recoveryEvent('run-a', 2, 2),
      messageEvent('run-a', 3, 'message.started', { messageId: 'assistant-run-a' }),
      messageEvent('run-a', 4, 'message.delta', {
        delta: 'A answer',
        messageId: 'assistant-run-a',
      }),
    ]
    const runBEvents = [
      messageEvent('run-b', 1, 'message.started', { messageId: 'assistant-run-b' }),
      messageEvent('run-b', 2, 'message.delta', {
        delta: 'B',
        messageId: 'assistant-run-b',
      }),
    ]
    const projector = createChatRunTranscriptProjector()
    const initialBuckets = replaceChatRunEventBuckets([...runAEvents, ...runBEvents])
    const initial = projector.project(initialBuckets, [runA, runB])

    const updated = projector.project(mergeChatRunEventBuckets(initialBuckets, [
      messageEvent('run-b', 3, 'message.delta', {
        delta: '+',
        messageId: 'assistant-run-b',
      }),
    ]), [runA, runB])

    expect(updated[0]).toBe(initial[0])
    expect(updated[0]?.turn).toBe(initial[0]?.turn)
    expect(updated[0]?.recoveryNotices).toEqual([{
      createdAt: '2026-09-03T00:00:02.000Z',
      missingAttachmentCount: 2,
      runId: 'run-a',
      sequence: 2,
    }])
    expect(updated[1]).not.toBe(initial[1])
    expect(updated[1]?.turn).toBe(initial[1]?.turn)
    expect(updated[1]?.turn.nodes).toMatchObject([])
    expect(updated[1]?.streamingMessages[0]?.text).toBe('B+')
  })

  it('preserves the message start time while a terminal result awaits persistence', () => {
    const completedRun: LocalRun = {
      ...run('run-a'),
      completedAt: '2026-09-03T00:00:03.000Z',
      status: 'completed',
    }
    const projection = createChatRunTranscriptProjector().project(
      replaceChatRunEventBuckets([
        messageEvent('run-a', 1, 'message.started', { messageId: 'assistant-run-a' }),
        messageEvent('run-a', 2, 'message.delta', {
          delta: 'Draft',
          messageId: 'assistant-run-a',
        }),
        messageEvent('run-a', 3, 'message.completed', {
          content: { text: 'Done' },
          messageId: 'assistant-run-a',
          role: 'assistant',
          stopReason: 'completed',
        }),
      ]),
      [completedRun],
    )[0]

    expect(projection?.streamingMessages[0]).toMatchObject({
      message: {
        createdAt: '2026-09-03T00:00:01.000Z',
      },
      text: 'Done',
    })
  })

  it('moves legacy tool-use text from the streaming row into commentary without dropping it', () => {
    const currentRun = run('run-a')
    const projector = createChatRunTranscriptProjector()
    const prefix = [
      messageEvent('run-a', 1, 'message.started', {
        messageId: 'assistant-run-a',
        role: 'assistant',
      }),
      messageEvent('run-a', 2, 'message.delta', {
        delta: 'CI is green. I will verify the merge state next.',
        messageId: 'assistant-run-a',
      }),
    ]
    const initialBuckets = replaceChatRunEventBuckets(prefix)
    const initial = projector.project(initialBuckets, [currentRun])[0]!

    expect(initial.streamingMessages).toMatchObject([{
      text: 'CI is green. I will verify the merge state next.',
    }])
    expect(initial.turn.nodes).toEqual([])

    const completed = projector.project(mergeChatRunEventBuckets(initialBuckets, [
      messageEvent('run-a', 3, 'message.completed', {
        content: { text: 'CI is green. I will verify the merge state next.' },
        messageId: 'assistant-run-a',
        role: 'assistant',
        stopReason: 'tool_use',
      }),
    ]), [currentRun])[0]!

    expect(completed.streamingMessages).toEqual([])
    expect(completed.turn.processMessageIds).toEqual(['assistant-run-a'])
    expect(completed.turn.nodes).toMatchObject([{
      kind: 'text',
      messageId: 'assistant-run-a',
      phase: 'commentary',
      text: 'CI is green. I will verify the merge state next.',
    }])
  })

  it('applies an appended suffix without rebuilding unaffected turn nodes', () => {
    const currentRun = run('run-a')
    const firstReasoning = reasoningEvent('run-a', 1, 'First', 0)
    const secondReasoning = reasoningEvent('run-a', 2, 'Second', 1)
    const initialEvents = [firstReasoning, secondReasoning]
    const projector = createChatRunTranscriptProjector()
    const initialBuckets = replaceChatRunEventBuckets(initialEvents)
    const initial = projector.project(
      initialBuckets,
      [currentRun],
    )[0]!

    const updated = projector.project(mergeChatRunEventBuckets(initialBuckets, [
      reasoningEvent('run-a', 3, '+', 1),
    ]), [currentRun])[0]!

    expect(updated.turn.nodes.map(node => 'text' in node ? node.text : null)).toEqual([
      'First',
      'Second+',
    ])
    expect(updated.turn.nodes[0]).toBe(initial.turn.nodes[0])
    expect(updated.turn.nodes[1]).not.toBe(initial.turn.nodes[1])
    expect(updated.recoveryNotices).toBe(initial.recoveryNotices)
  })

  it('keeps compaction lifecycle order and untouched reasoning when later events append', () => {
    const currentRun = run('run-a')
    const projector = createChatRunTranscriptProjector()
    const initialBuckets = replaceChatRunEventBuckets([
      reasoningEvent('run-a', 1, 'Before', 0),
      messageEvent('run-a', 2, 'context.compaction.started', { reason: 'overflow' }),
      reasoningEvent('run-a', 3, 'During', 1),
    ])
    const initial = projector.project(initialBuckets, [currentRun])[0]!
    const updatedBuckets = mergeChatRunEventBuckets(initialBuckets, [
      messageEvent('run-a', 4, 'context.compaction.completed', {
        estimatedTokensAfter: 2000,
        tokensBefore: 8000,
      }),
      messageEvent('run-a', 5, 'context.compaction.started', { reason: 'overflow' }),
      messageEvent('run-a', 6, 'context.compaction.cancelled', {}),
      reasoningEvent('run-a', 7, 'After', 2),
    ])
    const updated = projector.project(updatedBuckets, [currentRun])[0]!

    expect(updated.turn.nodes).toMatchObject([
      { kind: 'reasoning', text: 'Before' },
      {
        estimatedTokensAfter: 2000,
        id: 'compaction:run-a:2',
        kind: 'compaction',
        status: 'completed',
        tokensBefore: 8000,
      },
      { kind: 'reasoning', text: 'During' },
      { id: 'compaction:run-a:5', kind: 'compaction', status: 'cancelled' },
      { kind: 'reasoning', text: 'After' },
    ])
    expect(updated.turn.nodes[0]).toBe(initial.turn.nodes[0])
    expect(updated.turn.nodes[2]).toBe(initial.turn.nodes[2])
    expect(updated).toEqual(createChatRunTranscriptProjector().project(updatedBuckets, [currentRun])[0])
  })

  it('drops superseded tool snapshots while applying the latest snapshot incrementally', () => {
    const currentRun = run('run-a')
    const firstUpdate = messageEvent('run-a', 1, 'tool.updated', {
      presentation: terminalPresentation('first'),
      toolCallId: 'tool-1',
      toolName: 'bash',
    })
    const secondUpdate = messageEvent('run-a', 2, 'tool.updated', {
      presentation: terminalPresentation('first\nsecond'),
      toolCallId: 'tool-1',
      toolName: 'bash',
    })
    const projector = createChatRunTranscriptProjector()
    expect(mergeChatRunEventBuckets(new Map(), [firstUpdate, secondUpdate]).get('run-a')?.events)
      .toEqual([secondUpdate])
    const initialBuckets = replaceChatRunEventBuckets([firstUpdate])
    projector.project(initialBuckets, [currentRun])

    const updatedBuckets = mergeChatRunEventBuckets(initialBuckets, [secondUpdate])
    const updatedBucket = updatedBuckets.get('run-a')
    const projection = projector.project(updatedBuckets, [currentRun])[0]

    expect(updatedBucket?.events).toEqual([secondUpdate])
    expect((updatedBucket?.update as unknown as { events?: ReadonlyArray<LocalRunEvent> })?.events)
      .toEqual([secondUpdate])
    expect(projection?.turn.nodes).toMatchObject([{
      presentation: { output: 'first\nsecond' },
      toolCallId: 'tool-1',
    }])
  })

  it('replays a terminal checkpoint followed by output deltas', () => {
    const currentRun = run('run-a')
    const started = messageEvent('run-a', 1, 'tool.started', {
      presentation: terminalPresentation(null),
      toolCallId: 'tool-1',
      toolName: 'bash',
    })
    const checkpoint = messageEvent('run-a', 2, 'tool.updated', {
      presentation: terminalPresentation('first'),
      toolCallId: 'tool-1',
      toolName: 'bash',
    })
    const delta = messageEvent('run-a', 3, 'tool.updated', {
      presentationDelta: {
        card: 'terminal',
        outputDelta: '\nsecond',
        outputStart: 5,
        truncated: false,
      },
      toolCallId: 'tool-1',
      toolName: 'bash',
    })
    const projector = createChatRunTranscriptProjector()
    const initialBuckets = replaceChatRunEventBuckets([started, checkpoint])
    projector.project(initialBuckets, [currentRun])

    const updatedBuckets = mergeChatRunEventBuckets(initialBuckets, [delta])
    const incremental = projector.project(updatedBuckets, [currentRun])[0]
    const replayed = createChatRunTranscriptProjector().project(updatedBuckets, [currentRun])[0]

    expect(updatedBuckets.get('run-a')?.events).toEqual([started, checkpoint, delta])
    expect(incremental?.turn.nodes).toMatchObject([{
      presentation: { output: 'first\nsecond' },
    }])
    expect(replayed).toEqual(incremental)
  })

  it('matches a full replay when approval, tool, recovery, and message events append', () => {
    const currentRun = run('run-a')
    const prefix = [
      reasoningEvent('run-a', 1, 'Inspecting', 0),
      messageEvent('run-a', 2, 'approval.requested', {
        id: 'approval-1',
        kind: 'shell',
        review: {
          card: 'shell',
          command: 'pwd',
          toolName: 'bash',
        },
        status: 'pending',
        summary: 'Run a command',
        toolCallId: 'tool-1',
      }),
    ]
    const suffix = [
      messageEvent('run-a', 3, 'approval.resolved', {
        id: 'approval-1',
        resolvedAt: '2026-09-03T00:00:03.000Z',
        status: 'approved',
      }),
      messageEvent('run-a', 4, 'tool.completed', {
        isError: false,
        presentation: terminalPresentation('done'),
        toolCallId: 'tool-1',
        toolName: 'bash',
      }),
      recoveryEvent('run-a', 5, 2),
      messageEvent('run-a', 6, 'message.started', { messageId: 'assistant-run-a' }),
      messageEvent('run-a', 7, 'message.delta', {
        delta: 'Finished',
        messageId: 'assistant-run-a',
      }),
    ]
    const projector = createChatRunTranscriptProjector()
    const initialBuckets = replaceChatRunEventBuckets(prefix)
    projector.project(initialBuckets, [currentRun])

    const incremental = projector.project(
      mergeChatRunEventBuckets(initialBuckets, suffix),
      [currentRun],
    )[0]
    const rebuilt = createChatRunTranscriptProjector().project(
      replaceChatRunEventBuckets([...prefix, ...suffix]),
      [currentRun],
    )[0]

    expect(incremental).toEqual(rebuilt)
  })

  it('retains the registered tool label across output deltas and replay', () => {
    const activeRun = run('run-a')
    const start = messageEvent('run-a', 1, 'tool.started', {
      toolCallId: 'tool-1',
      toolName: 'bash',
      toolLabel: 'Run a shell command',
      presentation: terminalPresentation('first'),
    })
    const projector = createChatRunTranscriptProjector()
    const initial = replaceChatRunEventBuckets([start])
    projector.project(initial, [activeRun])
    const buckets = mergeChatRunEventBuckets(initial, [messageEvent('run-a', 2, 'tool.updated', {
      toolCallId: 'tool-1',
      toolName: 'bash',
      presentationDelta: { card: 'terminal', outputStart: 5, outputDelta: '+next', truncated: false },
    })])
    const result = projector.project(buckets, [activeRun])[0]
    expect(result?.turn.nodes[0]).toMatchObject({ toolLabel: 'Run a shell command', presentation: { output: 'first+next' } })
    expect(result).toEqual(createChatRunTranscriptProjector().project(buckets, [activeRun])[0])
  })

  it('rebuilds after a snapshot replaces or shrinks the event prefix', () => {
    const currentRun = run('run-a')
    const projector = createChatRunTranscriptProjector()
    const initialEvents = [
      reasoningEvent('run-a', 1, 'Old first', 0),
      reasoningEvent('run-a', 2, 'Old second', 1),
    ]
    projector.project(replaceChatRunEventBuckets(initialEvents), [currentRun])

    const replacedEvents = [
      reasoningEvent('run-a', 1, 'New first', 0),
      reasoningEvent('run-a', 2, 'New second', 1),
    ]
    const replaced = projector.project(
      replaceChatRunEventBuckets(replacedEvents),
      [currentRun],
    )[0]!
    expect(replaced.turn.nodes.map(node => 'text' in node ? node.text : null)).toEqual([
      'New first',
      'New second',
    ])

    const shrunk = projector.project(
      replaceChatRunEventBuckets([replacedEvents[0]!]),
      [currentRun],
    )[0]!
    expect(shrunk.turn.nodes.map(node => 'text' in node ? node.text : null)).toEqual([
      'New first',
    ])
  })

  it('rebuilds when an older event is inserted before the processed cursor', () => {
    const currentRun = run('run-a')
    const laterEvent = reasoningEvent('run-a', 2, 'Later', 1)
    const projector = createChatRunTranscriptProjector()
    const initialBuckets = replaceChatRunEventBuckets([laterEvent])
    projector.project(initialBuckets, [currentRun])

    const projected = projector.project(mergeChatRunEventBuckets(initialBuckets, [
      reasoningEvent('run-a', 1, 'Earlier', 0),
    ]), [currentRun])[0]!

    expect(projected.turn.nodes.map(node => 'text' in node ? node.text : null)).toEqual([
      'Earlier',
      'Later',
    ])
  })
})

function run(id: string): LocalRun {
  return {
    branchId: 'branch-1',
    completedAt: null,
    conversationId: 'conversation-1',
    errorCode: null,
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write',
    id,
    modelId: 'model-1',
    providerId: 'provider-1',
    purpose: 'chat',
    reasoningLevel: null,
    startedAt: '2026-09-03T00:00:00.000Z',
    status: 'running',
    triggeringMessageId: `message-${id}`,
  }
}

function reasoningEvent(
  runId: string,
  sequence: number,
  delta: string,
  contentIndex = 0,
): LocalRunEvent {
  return {
    createdAt: `2026-09-03T00:00:0${sequence}.000Z`,
    payload: {
      contentIndex,
      delta,
      kind: 'reasoning',
      messageId: `assistant-${runId}`,
    },
    runId,
    sequence,
    type: 'message.block.delta',
  }
}

function recoveryEvent(
  runId: string,
  sequence: number,
  missingAttachmentCount: number,
): LocalRunEvent {
  return messageEvent(runId, sequence, 'session.recovery.degraded', {
    missingAttachmentCount,
  })
}

function terminalPresentation(output: string | null) {
  return {
    card: 'terminal' as const,
    command: 'pwd',
    cwd: '.',
    description: null,
    exitCode: 0,
    output,
    signal: null,
    truncated: false,
  }
}

function messageEvent(
  runId: string,
  sequence: number,
  type: string,
  payload: LocalRunEvent['payload'],
): LocalRunEvent {
  return {
    createdAt: `2026-09-03T00:00:0${sequence}.000Z`,
    payload,
    runId,
    sequence,
    type,
  }
}
