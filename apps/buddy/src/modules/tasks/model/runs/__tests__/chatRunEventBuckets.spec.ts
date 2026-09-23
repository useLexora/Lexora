import type { LocalRunEvent } from '@buddy-shared/runs/runApi'

import { describe, expect, it } from 'vitest'
import {
  compactChatRunEventSnapshots,
  mergeChatRunEventBuckets,
  replaceChatRunEventBuckets,
} from '../chatRunEventBuckets'

describe('chat run event buckets', () => {
  it('preserves unchanged run projections when an older run is added', () => {
    const latest = event('run-b', 1)
    const initial = replaceChatRunEventBuckets([latest])
    const older = event('run-a', 1)
    const updated = replaceChatRunEventBuckets([older, latest], initial)

    expect(updated.get('run-b')).toBe(initial.get('run-b'))
    expect(updated.get('run-a')?.events).toEqual([older])
    const replacement = { ...latest, payload: { delta: 'corrected', messageId: 'assistant-run-b' } }
    const corrected = replaceChatRunEventBuckets([replacement], updated)
    expect([...corrected.keys()]).toEqual(['run-b'])
    expect(corrected.get('run-b')?.events).toEqual([replacement])
    expect(corrected.get('run-b')).not.toBe(updated.get('run-b'))
  })

  it('appends ordered events without rescanning existing sort keys', () => {
    let existingCreatedAtReads = 0
    const existing = event('run-a', 1)
    Object.defineProperty(existing, 'createdAt', {
      enumerable: true,
      get() {
        existingCreatedAtReads += 1
        return '2026-09-03T00:00:01.000Z'
      },
    })
    const initial = replaceChatRunEventBuckets([existing])
    existingCreatedAtReads = 0
    const appended = event('run-a', 2)

    const updated = mergeChatRunEventBuckets(initial, [appended])
    const bucket = updated.get('run-a')

    expect(existingCreatedAtReads).toBe(0)
    expect(bucket?.events).toEqual([existing, appended])
    expect(bucket?.update).toEqual({
      events: [appended],
      kind: 'append',
      previousRevision: initial.get('run-a')?.revision,
    })
  })

  it('compacts preparing events when tool has started or completed, but preserves preparing for failed tools', () => {
    const events: LocalRunEvent[] = [
      {
        createdAt: '2026-09-03T00:00:01.000Z',
        payload: { presentation: { card: 'file' }, toolCallId: 'tool-completed' },
        runId: 'run-1',
        sequence: 1,
        type: 'tool.preparing',
      },
      {
        createdAt: '2026-09-03T00:00:02.000Z',
        payload: { presentation: { card: 'file' }, toolCallId: 'tool-completed' },
        runId: 'run-1',
        sequence: 2,
        type: 'tool.completed',
      },
      {
        createdAt: '2026-09-03T00:00:03.000Z',
        payload: { presentation: { card: 'file' }, toolCallId: 'tool-failed' },
        runId: 'run-1',
        sequence: 3,
        type: 'tool.preparing',
      },
      {
        createdAt: '2026-09-03T00:00:04.000Z',
        payload: { errorCode: 'PATH_NOT_FOUND', toolCallId: 'tool-failed' },
        runId: 'run-1',
        sequence: 4,
        type: 'tool.failed',
      },
      {
        createdAt: '2026-09-03T00:00:05.000Z',
        payload: {},
        runId: 'run-1',
        sequence: 5,
        type: 'run.failed',
      },
    ]

    const compacted = compactChatRunEventSnapshots(events)
    expect(compacted.map(item => item.sequence)).toEqual([2, 3, 4, 5])
  })
})

function event(runId: string, sequence: number): LocalRunEvent {
  return {
    createdAt: `2026-09-03T00:00:0${sequence}.000Z`,
    payload: {
      delta: `${sequence}`,
      messageId: `assistant-${runId}`,
    },
    runId,
    sequence,
    type: 'message.delta',
  }
}
