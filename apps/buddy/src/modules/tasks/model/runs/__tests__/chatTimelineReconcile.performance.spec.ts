import type { LocalConversationTimelinePage } from '@buddy-shared/conversation/conversationApi'
import type { ChatRunEventBuckets } from '../typing'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { mergeChatRunEventBuckets } from '../chatRunEventBuckets'
import { reconcileTimelineEventBuckets } from '../chatTimelineMerge'
import { event, expectEquivalent, legacyReconcile, page, run } from './chatTimelineReconcile.fixtures'

const RUN_COUNT = 500
const EVENTS_PER_RUN = 80
const TAIL_ADDED_EVENTS = 32
const OLDER_RUN_EVENT_COUNT = 32
const TERMINAL_PAGE_RUN_COUNT = 10
const WARMUP_COUNT = 12
const SAMPLE_COUNT = 80

interface Scenario {
  name: string
  current: ChatRunEventBuckets
  incoming: LocalConversationTimelinePage
  dirtyRunIds: ReadonlySet<string>
}

describe.skipIf(process.env.LEXORA_CHAT_RECONCILE_BENCHMARK !== '1')('timeline reconciliation performance', () => {
  it('compares equivalent old and new merges with fixed history, pages and dirty runs', () => {
    const history = Array.from({ length: RUN_COUNT }, (_, runIndex) => historyRunEvents(runIndex, EVENTS_PER_RUN)).flat()
    const initial = reconcileTimelineEventBuckets(new Map(), history, [], new Set()).buckets
    const tailPage = page(historyRunEvents(RUN_COUNT - 1, EVENTS_PER_RUN + TAIL_ADDED_EVENTS), [run(`history-${RUN_COUNT - 1}`)])
    const terminalPage = page(
      Array.from({ length: TERMINAL_PAGE_RUN_COUNT }, (_, runIndex) => historyRunEvents(runIndex, EVENTS_PER_RUN)).flat(),
      Array.from({ length: TERMINAL_PAGE_RUN_COUNT }, (_, runIndex) => run(`history-${runIndex}`, 'completed')),
    )
    const dirtyRunId = 'history-250'
    const dirty = mergeChatRunEventBuckets(initial, [
      event(dirtyRunId, 81, { createdAt: timestamp(250080), type: 'tool.preparing', payload: { toolCallId: 'dirty-tool' } }),
      event(dirtyRunId, 82, { createdAt: timestamp(250081), type: 'tool.started', payload: { toolCallId: 'dirty-tool' } }),
    ])
    const scenarios: Scenario[] = [
      { name: 'complete tail run snapshot', current: initial, incoming: tailPage, dirtyRunIds: new Set() },
      {
        name: 'older page prepend',
        current: initial,
        incoming: page(
          Array.from({ length: OLDER_RUN_EVENT_COUNT }, (_, index) => event('older-run', index + 1, { createdAt: timestamp(index - 1000) })),
          [run('older-run', 'completed')],
        ),
        dirtyRunIds: new Set(),
      },
      { name: 'complete tail snapshot + one dirty run', current: dirty, incoming: tailPage, dirtyRunIds: new Set([dirtyRunId]) },
      { name: 'overlapping complete terminal run page', current: initial, incoming: terminalPage, dirtyRunIds: new Set() },
    ]
    const results = scenarios.map(measure)
    process.stdout.write(`${JSON.stringify({ runCount: RUN_COUNT, eventsPerRun: EVENTS_PER_RUN, historyEvents: history.length, cache: 'warm bucket indexes', warmupCount: WARMUP_COUNT, sampleCount: SAMPLE_COUNT, node: process.version, platform: process.platform, results })}\n`)
  }, 30_000)
})

function measure(scenario: Scenario) {
  const previousMerge = () => legacyReconcile(scenario.current, scenario.incoming)
  const nextMerge = () => reconcileTimelineEventBuckets(scenario.current, scenario.incoming.runEvents, scenario.incoming.runs, scenario.dirtyRunIds)
  const expected = previousMerge()
  expectEquivalent(nextMerge(), expected)
  for (let index = 0; index < WARMUP_COUNT; index++) {
    previousMerge()
    nextMerge()
  }
  const previousSamples: number[] = []
  const nextSamples: number[] = []
  let sink = expected
  function sample(merge: typeof previousMerge, samples: number[]) {
    const startedAt = performance.now()
    sink = merge()
    samples.push(performance.now() - startedAt)
  }
  for (let index = 0; index < SAMPLE_COUNT; index++) {
    if (index % 2 === 0) {
      sample(previousMerge, previousSamples)
      sample(nextMerge, nextSamples)
    }
    else {
      sample(nextMerge, nextSamples)
      sample(previousMerge, previousSamples)
    }
  }
  expectEquivalent(sink, expected)
  expect(previousSamples).toHaveLength(SAMPLE_COUNT)
  return {
    scenario: scenario.name,
    pageRuns: scenario.incoming.runs.length,
    pageEvents: scenario.incoming.runEvents.length,
    dirtyRuns: scenario.dirtyRunIds.size,
    oldP50Ms: percentile(previousSamples, 0.5),
    oldP95Ms: percentile(previousSamples, 0.95),
    newP50Ms: percentile(nextSamples, 0.5),
    newP95Ms: percentile(nextSamples, 0.95),
  }
}

function percentile(samples: number[], fraction: number) {
  return Number([...samples].sort((left, right) => left - right)[Math.ceil(samples.length * fraction) - 1]!.toFixed(3))
}

function historyRunEvents(runIndex: number, count: number) {
  return Array.from({ length: count }, (_, index) => event(`history-${runIndex}`, index + 1, {
    createdAt: timestamp(runIndex * 1000 + index),
    type: index === 39 ? 'context.usage.updated' : 'message.delta',
  }))
}

function timestamp(seconds: number) {
  return new Date(Date.UTC(2026, 8, 3, 0, 0, seconds)).toISOString()
}
