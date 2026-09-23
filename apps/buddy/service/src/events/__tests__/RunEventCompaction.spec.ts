import type { BuddyRunEvent } from '../BuddyRunEvent'
import { describe, expect, it } from 'vitest'
import { createRunEventCompactionPlan } from '../RunEventCompaction'

describe('runEventCompaction', () => {
  it('removes completed stream details while retaining live state and event order', () => {
    const events = [
      event(1, 'run.started', {}),
      event(2, 'message.delta', { messageId: 'message-completed' }),
      event(3, 'message.completed', { messageId: 'message-completed' }),
      event(4, 'message.delta', { messageId: 'message-live' }),
      event(5, 'message.block.delta', {
        contentIndex: 0,
        kind: 'reasoning',
        messageId: 'message-block',
      }),
      event(6, 'message.block.completed', {
        contentIndex: 0,
        kind: 'reasoning',
        messageId: 'message-block',
      }),
      event(7, 'message.block.delta', {
        contentIndex: 0,
        kind: 'text',
        messageId: 'message-block',
      }),
      event(8, 'tool.updated', { toolCallId: 'tool-completed' }),
      event(9, 'tool.completed', { toolCallId: 'tool-completed' }),
      event(10, 'tool.updated', { toolCallId: 'tool-live' }),
      event(11, 'tool.updated', { toolCallId: 'tool-live' }),
      event(12, 'run.completed', {}),
    ]

    const plan = createRunEventCompactionPlan(events)

    expect(plan.removed.map(item => item.sequence)).toEqual([2, 5, 8, 10])
    expect(plan.retained.map(item => item.sequence)).toEqual([1, 3, 4, 6, 7, 9, 11, 12])
  })

  it('retains the latest tool checkpoint and every following output delta', () => {
    const events = [
      event(1, 'tool.updated', {
        presentation: { card: 'terminal', output: 'old' },
        toolCallId: 'tool-live',
      }),
      event(2, 'tool.updated', {
        presentationDelta: {
          card: 'terminal',
          outputDelta: ' output',
          outputStart: 3,
          truncated: false,
        },
        toolCallId: 'tool-live',
      }),
      event(3, 'tool.updated', {
        presentation: { card: 'terminal', output: 'replacement' },
        toolCallId: 'tool-live',
      }),
      event(4, 'tool.updated', {
        presentationDelta: {
          card: 'terminal',
          outputDelta: ' tail',
          outputStart: 11,
          truncated: false,
        },
        toolCallId: 'tool-live',
      }),
    ]

    const plan = createRunEventCompactionPlan(events)

    expect(plan.removed.map(item => item.sequence)).toEqual([1, 2])
    expect(plan.retained.map(item => item.sequence)).toEqual([3, 4])
  })

  it('compacts transient progress and completed tool preparing events', () => {
    const events = [
      event(1, 'run.started', {}),
      event(2, 'run.progress', { phase: 'thinking' }),
      event(3, 'tool.preparing', { toolCallId: 'tool-done' }),
      event(4, 'tool.completed', { toolCallId: 'tool-done' }),
      event(5, 'tool.preparing', { toolCallId: 'tool-pending' }),
      event(6, 'run.completed', {}),
    ]

    const plan = createRunEventCompactionPlan(events)

    expect(plan.removed.map(item => item.sequence)).toEqual([2, 3])
    expect(plan.retained.map(item => item.sequence)).toEqual([1, 4, 5, 6])
  })
})

function event(sequence: number, type: string, payload: unknown): BuddyRunEvent {
  return {
    createdAt: '2026-08-28T00:00:00.000Z',
    payload,
    runId: 'run-1',
    sequence,
    type,
  }
}
