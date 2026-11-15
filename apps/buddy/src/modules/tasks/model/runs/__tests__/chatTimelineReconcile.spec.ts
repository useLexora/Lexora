import type { LocalConversationTimelinePage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { ChatRunEventBuckets } from '../typing'
import { describe, expect, it } from 'vitest'
import { useChatRunProjection } from '../../../state/runs/useChatRunProjection'
import { mergeChatRunEventBuckets, mergeChatRunEvents } from '../chatRunEventBuckets'
import { isRunSignalEvent } from '../chatTimelineMerge'
import { event, expectEquivalent, legacyReconcile, page, run } from './chatTimelineReconcile.fixtures'

describe('timeline event bucket reconciliation', () => {
  it('preserves out-of-order inserts, overlapping pages and same-key corrections without append hints', () => {
    const harness = createHarness()
    const initial = [event('a', 2), event('b', 3), event('a', 4)]
    harness.snapshot(page(initial))
    const unchanged = harness.projection.state.runEventBuckets.value.get('b')
    harness.snapshot(page([event('a', 1), event('a', 3)]), true)
    expect(harness.projection.state.runEventBuckets.value.get('b')).toBe(unchanged)
    expect(harness.projection.state.runEventBuckets.value.get('a')?.update).toBeNull()
    const correction = event('a', 2, { payload: { delta: 'corrected' } })
    harness.snapshot(page([event('a', 2), correction, initial[2]!]), true)
    expect(harness.projection.state.runEventBuckets.value.get('a')?.events[1]).toBe(correction)
    expect(harness.projection.state.runEventBuckets.value.get('a')?.update).toBeNull()
  })

  it.each(['queued', 'running', 'completed', 'failed', 'cancelled'] as const)('handles %s page runs without deleting unlisted history', (status) => {
    const harness = createHarness()
    harness.snapshot(page([event('a', 1), event('b', 1)]))
    harness.snapshot(page([], [run('a', status)]))
    expect(harness.projection.state.runEventBuckets.value.has('a')).toBe(status === 'queued' || status === 'running')
    expect(harness.projection.state.runEventBuckets.value.has('b')).toBe(true)
    harness.snapshot(page([event('a', 3)], [run('a', 'completed')]))
    expect(harness.projection.state.runEventBuckets.value.get('a')?.events.map(event => event.sequence)).toEqual([3])
  })

  it('compacts a dirty streaming run on an unrelated older page and empty snapshot', () => {
    const harness = createHarness()
    harness.snapshot(page([event('active', 1)]))
    const prepare = event('active', 2, { type: 'tool.preparing', payload: { toolCallId: 'tool-a' } })
    const start = event('active', 3, { type: 'tool.started', payload: { toolCallId: 'tool-a' } })
    harness.append([prepare])
    harness.append([start])
    expect(harness.projection.state.runEventBuckets.value.get('active')?.events).toContain(prepare)
    harness.snapshot(page([event('older', 1)]), true)
    expect(harness.projection.state.runEventBuckets.value.get('active')?.events).not.toContain(prepare)
    expect(harness.projection.state.runEventBuckets.value.get('active')?.update).toBeNull()
    const progress = event('active', 4, { type: 'run.progress' })
    harness.append([progress, event('active', 5, { type: 'run.completed' })])
    harness.snapshot(page())
    expect(harness.projection.state.runEventBuckets.value.get('active')?.events).not.toContain(progress)
  })

  it('retains global stable signal order across changed Map order, new keys and signal corrections', () => {
    const harness = createHarness()
    const signalA = event('a', 2, { type: 'context.usage.updated' })
    const signalB = event('b', 2, { type: 'context.compaction.completed' })
    harness.snapshot(page([event('a', 1), signalA, signalB]))
    harness.snapshot(page([event('b', 1, { createdAt: '2026-09-03T00:00:00.000Z' })]), true)
    expect([...harness.projection.state.runEventBuckets.value.keys()]).toEqual(['b', 'a'])
    expect(harness.projection.state.runSignalEvents.value).toEqual([signalA, signalB])
    harness.snapshot(page())
    expect(harness.projection.state.runSignalEvents.value).toEqual([signalB, signalA])
    harness.snapshot(page([event('a', 1, { type: 'context.usage.updated' }), event('b', 2)]))
    expect(harness.projection.state.runSignalEvents.value.map(event => `${event.runId}:${event.sequence}`)).toEqual(['a:1', 'a:2'])

    harness.projection.clear()
    harness.resetLegacy()
    harness.snapshot(page([event('a', 1), signalB]))
    harness.snapshot(page([signalA]))
    expect(harness.projection.state.runSignalEvents.value).toEqual([signalB, signalA])
    harness.snapshot(page([signalA], [run('a', 'completed')]))
    expect([...harness.projection.state.runEventBuckets.value.keys()]).toEqual(['b', 'a'])
    expect(harness.projection.state.runSignalEvents.value).toEqual([signalB, signalA])
  })

  it('keeps retained dirty runs reconcilable after replacing a turn and clears discarded history', () => {
    const projection = useChatRunProjection()
    const runIds = ['retained', 'discarded']
    projection.applySnapshot({
      ...page(runIds.map(runId => event(runId, 1))),
      items: runIds.map(runId => ({
        attachments: [],
        branchId: 'branch-fixture',
        content: { text: runId },
        conversationId: 'conversation-fixture',
        createdAt: '2026-09-03T00:00:00.000Z',
        id: `message-${runId}`,
        kind: 'message',
        role: 'assistant',
        runId,
      })),
    }, [])
    projection.appendEvents(runIds.flatMap(runId => [
      event(runId, 2, { type: 'tool.preparing', payload: { toolCallId: 'tool' } }),
      event(runId, 3, { type: 'tool.started', payload: { toolCallId: 'tool' } }),
    ]))
    projection.replaceTurn(run('replacement'), 'message-discarded', false)
    projection.applySnapshot(page(), [])
    expect([...projection.state.runEventBuckets.value.keys()]).toEqual(['retained'])
    expect(projection.state.runEventBuckets.value.get('retained')?.events.map(event => event.sequence)).toEqual([1, 3])
    projection.clear()
    projection.applySnapshot(page([event('retained', 1, { type: 'context.usage.updated' })]), [])
    expect(projection.state.runSignalEvents.value).toHaveLength(1)
    expect(projection.state.runEventBuckets.value.get('retained')?.events).toHaveLength(1)
  })

  it('does not revisit unaffected historical event fields on a tail snapshot', () => {
    const projection = useChatRunProjection()
    const reads = { createdAt: 0, sequence: 0, type: 0 }
    const history = Array.from({ length: 4 }, (_, runIndex) => Array.from({ length: 8 }, (_, index) => {
      const original = event(`history-${runIndex}`, index + 1)
      const observed = { ...original }
      for (const field of ['createdAt', 'sequence', 'type'] as const) {
        Object.defineProperty(observed, field, {
          enumerable: true,
          get() {
            reads[field] += 1
            return original[field]
          },
        })
      }
      return observed
    })).flat()
    projection.applySnapshot(page(history), [])
    const previous = projection.state.runEventBuckets.value
    reads.createdAt = reads.sequence = reads.type = 0
    projection.applySnapshot(page([event('new-run', 1)]), [])
    expect(reads).toEqual({ createdAt: 0, sequence: 0, type: 0 })
    for (const [runId, bucket] of previous)
      expect(projection.state.runEventBuckets.value.get(runId)).toBe(bucket)
  })

  it.each([1, 7, 42, 109, 2026])('matches the former full merge throughout mixed operations (seed %i)', (seed) => {
    const harness = createHarness()
    const random = createRandom(seed)
    const types = ['message.delta', 'tool.preparing', 'tool.started', 'tool.updated', 'tool.completed', 'run.progress', 'run.completed', 'context.usage.updated', 'context.compaction.completed']
    const statuses: LocalRun['status'][] = ['queued', 'running', 'completed', 'failed', 'cancelled']
    for (let step = 0; step < 150; step++) {
      const incoming = Array.from({ length: random(7) }, () => {
        const sequence = random(12) + 1
        const toolCallId = `tool-${random(2)}`
        const type = types[random(types.length)]!
        return event(`run-${random(5)}`, sequence, {
          createdAt: event('', random(4)).createdAt,
          type,
          payload: random(2)
            ? { toolCallId, presentation: { card: 'browser', operation: 'open' } }
            : { toolCallId, presentationDelta: { text: `${step}` } },
        })
      })
      if (random(3) === 0) {
        harness.append(incoming)
      }
      else {
        const runs = Array.from({ length: random(3) }, () => run(`run-${random(5)}`, statuses[random(statuses.length)]!))
        harness.snapshot(page(incoming, runs), random(2) === 0)
      }
    }
    harness.snapshot(page())
  })
})

function createHarness() {
  const projection = useChatRunProjection()
  let buckets: ChatRunEventBuckets = new Map()
  let signals: ReadonlyArray<LocalRunEvent> = []
  function check() {
    expectEquivalent({ buckets: projection.state.runEventBuckets.value, signals: projection.state.runSignalEvents.value }, { buckets, signals })
  }
  return {
    projection,
    append(incoming: ReadonlyArray<LocalRunEvent>) {
      const incomingSignals = incoming.filter(isRunSignalEvent)
      if (incomingSignals.length)
        signals = mergeChatRunEvents(signals, incomingSignals)
      buckets = mergeChatRunEventBuckets(buckets, incoming)
      projection.appendEvents(incoming)
      check()
    },
    resetLegacy() {
      buckets = new Map()
      signals = []
    },
    snapshot(incoming: LocalConversationTimelinePage, prepend = false) {
      const reconciled = legacyReconcile(buckets, incoming)
      buckets = reconciled.buckets
      signals = reconciled.signals
      if (prepend)
        projection.prependPage(incoming)
      else
        projection.applySnapshot(incoming, [])
      check()
    },
  }
}

function createRandom(seed: number) {
  let state = seed
  return (maximum: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % maximum
  }
}
