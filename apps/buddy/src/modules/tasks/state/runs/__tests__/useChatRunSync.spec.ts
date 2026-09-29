import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalConversationTimelineItem, LocalConversationTimelinePage, LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunEvent, LocalRunOutput } from '@buddy-shared/runs/runApi'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'

import { projectPersistedChatTranscriptRows } from '../../../model/transcript/chatPersistedTranscriptRows'
import { useChatRunSync } from '../useChatRunSync'

describe('useChatRunSync', () => {
  it('refreshes a running action on an older page and removes only automatic skipped actions from the transcript', async () => {
    const action: Extract<LocalConversationTimelineItem, { kind: 'extension-action' }> = {
      kind: 'extension-action',
      id: 'automatic',
      conversationId: 'task',
      branchId: 'branch',
      sourceMessageId: null,
      extensionId: 'tests.action',
      extensionName: 'Action',
      actionId: 'tests.action.run',
      title: 'Run',
      trigger: 'task:input:committed',
      status: 'running',
      message: null,
      createdAt: '2026-09-29T00:00:00.000Z',
      completedAt: null,
    }
    const manual = { ...action, id: 'manual', trigger: 'user' as const, status: 'skipped' as const }
    const latest = timelineMessage('latest', 'task', 'branch', 2)
    let completed = false
    const api = createApi({ listTimeline: async input => input.cursor
      ? timelinePage([{ ...action, status: completed ? 'skipped' : 'running' }, manual], null)
      : timelinePage([latest], 'older') })
    const sync = useChatRunSync({ activeBranchId: ref('branch'), activeConversationId: ref('task'), api, onError: (error) => {
      throw error
    } })
    try {
      await sync.refreshActiveConversation()
      await sync.loadOlderMessages()
      expect(sync.timelineItems.value.find(item => item.id === action.id)).toMatchObject({ status: 'running' })
      expect(projectPersistedChatTranscriptRows(sync.timelineItems.value, [])).toHaveLength(2)
      completed = true
      await sync.refreshActiveConversation()
      expect(sync.timelineItems.value.find(item => item.id === action.id)).toMatchObject({ status: 'skipped' })
      const rows = projectPersistedChatTranscriptRows(sync.timelineItems.value, [])
      expect(JSON.stringify(rows)).not.toContain('"id":"automatic"')
      expect(JSON.stringify(rows)).toContain('"id":"manual"')
      expect(sync.messages.value).toEqual([latest])
      expect(sync.hasOlderMessages.value).toBe(false)
    }
    finally { sync.dispose() }
  })

  it('restores the loaded range with fresh pages and keeps a switched task loading until the range is ready', async () => {
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    const older = timelineMessage('older-a', 'conversation-a', activeBranchId.value!, 1)
    const latest = timelineMessage('latest-a', 'conversation-a', activeBranchId.value!, 2)
    const pending = deferred<LocalConversationTimelinePage>()
    let restore = false
    const api = createApi({ listTimeline: async (input) => {
      if (input.conversationId === 'conversation-b')
        return timelinePage([timelineMessage('latest-b', 'conversation-b', 'branch-conversation-b', 1)], null)
      if (input.cursor)
        return restore ? pending.promise : timelinePage([older], null)
      return timelinePage([restore ? { ...latest, content: { text: 'updated while away' } } : latest], 'older')
    } })
    const sync = useChatRunSync({ activeBranchId, activeConversationId, api, onError: vi.fn() })
    try {
      await sync.refreshActiveConversation()
      await sync.loadOlderMessages()
      expect(sync.timelineItems.value.map(item => item.id)).toEqual(['older-a', 'latest-a'])
      activeConversationId.value = 'conversation-b'
      activeBranchId.value = 'branch-conversation-b'
      expect(sync.isLoadingConversation.value).toBe(true)
      await sync.refreshActiveConversation()
      expect(sync.messages.value.map(item => item.id)).toEqual(['latest-b'])
      restore = true
      activeConversationId.value = 'conversation-a'
      activeBranchId.value = 'branch-conversation-a'
      const refreshing = sync.refreshActiveConversation()
      await vi.waitUntil(() => vi.mocked(api.conversations.listTimeline).mock.calls.length === 5)
      expect(sync.isLoadingConversation.value).toBe(true)
      expect(sync.timelineItems.value).toEqual([])
      pending.resolve(timelinePage([older], null))
      await refreshing
      expect(sync.isLoadingConversation.value).toBe(false)
      expect(sync.messages.value.map(item => item.content)).toEqual([{ text: 'older-a' }, { text: 'updated while away' }])
      expect(sync.hasOlderMessages.value).toBe(false)
    }
    finally {
      sync.dispose()
    }
  })

  it('does not let a stale event fetch overwrite the newly active conversation', async () => {
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    const staleEvents = deferred<ReadonlyArray<LocalRunEvent>>()
    const api = createApi({
      listEvents: conversationId => conversationId === 'conversation-a'
        ? staleEvents.promise
        : Promise.resolve([event('run-b', 1)]),
    })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })

    const staleRefresh = sync.refreshActiveConversation()
    await vi.waitUntil(() => vi.mocked(api.conversations.listTimeline).mock.calls.length === 1)
    activeConversationId.value = 'conversation-b'
    activeBranchId.value = 'branch-conversation-b'
    await sync.refreshActiveConversation()
    staleEvents.resolve([event('run-a', 1)])
    await staleRefresh

    expect(sync.messages.value.map(message => message.conversationId)).toEqual(['conversation-b'])
    expect(sync.runs.value.map(run => run.id)).toEqual(['run-b'])
    expect([...sync.runEventBuckets.value.keys()]).toEqual(['run-b'])
  })

  it('accepts global notifications only for runs owned by the active conversation', async () => {
    const animationFrames = stubAnimationFrameWindow()
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    const api = createApi({ listEvents: async () => [] })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })
    await sync.refreshActiveConversation()

    sync.handleRunEvent(event('run-other', 1))
    sync.handleRunEvent(event('run-a', 1))
    animationFrames.flush()
    sync.handleRunEvent(event('run-a', 2))
    activeConversationId.value = 'conversation-b'
    activeBranchId.value = 'branch-conversation-b'
    sync.handleRunEvent(event('run-a', 3))
    animationFrames.flush()

    expect(sync.runEventBuckets.value.get('run-a')?.events.map(item => item.sequence)).toEqual([1])
    sync.dispose()
  })

  it('keeps ordinary streamed events incremental without refreshing the timeline', async () => {
    vi.useFakeTimers()
    const animationFrames = stubAnimationFrameWindow()
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    const api = createApi({ listEvents: async () => [] })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })

    try {
      await sync.refreshActiveConversation()
      const initialSignals = sync.runSignalEvents.value
      sync.handleRunEvent({ ...event('run-a', 1), type: 'tool.updated' })
      sync.handleRunEvent({ ...event('run-a', 2), type: 'message.delta' })
      expect(animationFrames.size()).toBe(1)
      animationFrames.flush()
      await vi.advanceTimersByTimeAsync(500)

      expect(sync.runSignalEvents.value).toBe(initialSignals)
      expect(api.conversations.listTimeline).toHaveBeenCalledTimes(1)
      expect(sync.runEventBuckets.value.get('run-a')?.events.map(item => item.sequence))
        .toEqual([1, 2])
    }
    finally {
      sync.dispose()
      vi.useRealTimers()
    }
  })

  it('retains a completed reply while steering continues the same running turn', async () => {
    vi.useFakeTimers()
    const animationFrames = stubAnimationFrameWindow()
    const activeRun = run('run-a', 'conversation-a')
    const initial = timelineMessage('message-conversation-a', 'conversation-a', activeRun.branchId, 1)
    const reply = {
      ...timelineMessage('assistant-a', 'conversation-a', activeRun.branchId, 2, 'assistant'),
      content: { text: '你好' },
      runId: activeRun.id,
    }
    let items: ReadonlyArray<LocalConversationTimelineItem> = [initial]
    const api = createApi({ listTimeline: async () => timelinePage(items, null, [activeRun]) })
    const sync = useChatRunSync({
      activeBranchId: ref(activeRun.branchId),
      activeConversationId: ref(activeRun.conversationId),
      api,
      onError: vi.fn(),
    })

    try {
      await sync.refreshActiveConversation()
      items = [initial, reply]
      sync.handleRunEvent({
        ...event(activeRun.id, 1),
        payload: { messageId: reply.id, role: 'assistant', phase: 'final_answer', content: reply.content },
        type: 'message.completed',
      })
      sync.handleRunEvent({
        ...event(activeRun.id, 2),
        payload: { messageId: 'assistant-continuation', delta: '继续任务', phase: 'final_answer' },
        type: 'message.delta',
      })
      animationFrames.flush()
      await vi.advanceTimersByTimeAsync(100)

      expect(sync.messages.value).toContainEqual(reply)
      expect(sync.runs.value[0]?.status).toBe('running')
      expect(sync.runEventBuckets.value.get(activeRun.id)?.events.at(-1)?.payload)
        .toMatchObject({ messageId: 'assistant-continuation', delta: '继续任务' })
    }
    finally {
      sync.dispose()
      vi.useRealTimers()
    }
  })

  it('refreshes the timeline when a streamed event sequence has a gap', async () => {
    vi.useFakeTimers()
    const animationFrames = stubAnimationFrameWindow()
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    let requestCount = 0
    const api = createApi({
      listTimeline: async () => {
        requestCount += 1
        return timelinePage(
          [timelineMessage('message-a', 'conversation-a', 'branch-conversation-a', 1)],
          null,
          [run('run-a', 'conversation-a')],
          requestCount === 1
            ? [event('run-a', 1), event('run-a', 2)]
            : [event('run-a', 1), event('run-a', 2), event('run-a', 3), event('run-a', 4)],
        )
      },
    })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })

    try {
      await sync.refreshActiveConversation()
      vi.mocked(api.conversations.listTimeline).mockClear()

      sync.handleRunEvent({ ...event('run-a', 4), type: 'message.delta' })
      animationFrames.flush()
      await vi.advanceTimersByTimeAsync(100)

      expect(api.conversations.listTimeline).toHaveBeenCalledTimes(1)
      expect(sync.runEventBuckets.value.get('run-a')?.events.map(event => event.sequence))
        .toEqual([1, 2, 3, 4])
    }
    finally {
      sync.dispose()
      vi.useRealTimers()
    }
  })

  it('retains context and tool-start events for cross-feature consumers', async () => {
    const animationFrames = stubAnimationFrameWindow()
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    const api = createApi({ listEvents: async () => [] })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })

    try {
      await sync.refreshActiveConversation()
      sync.handleRunEvent({
        ...event('run-a', 1),
        payload: {
          presentation: { card: 'terminal' },
          toolCallId: 'tool-terminal',
        },
        type: 'tool.started',
      })
      sync.handleRunEvent({ ...event('run-a', 2), type: 'message.delta' })
      sync.handleRunEvent({
        ...event('run-a', 3),
        payload: {
          presentation: { card: 'browser', operation: 'open' },
          toolCallId: 'tool-browser',
        },
        type: 'tool.started',
      })
      sync.handleRunEvent({ ...event('run-a', 4), type: 'context.usage.updated' })
      sync.handleRunEvent({ ...event('run-a', 5), type: 'context.compaction.completed' })
      animationFrames.flush()

      expect(sync.runSignalEvents.value.map(item => item.type)).toEqual([
        'tool.started',
        'context.usage.updated',
        'context.compaction.completed',
      ])
      expect(sync.runEventBuckets.value.get('run-a')?.events.map(item => item.sequence))
        .toEqual([1, 2, 3, 4, 5])
    }
    finally {
      sync.dispose()
    }
  })

  it('preserves unaffected run event buckets during an incremental commit', async () => {
    const animationFrames = stubAnimationFrameWindow()
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    const runA = run('run-a', 'conversation-a')
    const runB = { ...run('run-b', 'conversation-a'), status: 'completed' as const }
    const api = createApi({
      listTimeline: async () => timelinePage(
        [timelineMessage('message-a', 'conversation-a', 'branch-conversation-a', 1)],
        null,
        [runA, runB],
        [event('run-a', 1), event('run-b', 1)],
      ),
    })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })

    try {
      await sync.refreshActiveConversation()

      const { runEventBuckets } = sync
      const runABucket = runEventBuckets.value.get('run-a')
      const runBBucket = runEventBuckets.value.get('run-b')
      expect([...runEventBuckets.value.keys()]).toEqual(['run-a', 'run-b'])

      sync.handleRunEvent({ ...event('run-a', 2), type: 'message.delta' })
      animationFrames.flush()

      expect(runEventBuckets.value.get('run-a')?.events.map(item => item.sequence)).toEqual([1, 2])
      expect(runEventBuckets.value.get('run-a')?.update).toEqual({
        events: [expect.objectContaining({ sequence: 2 })],
        kind: 'append',
        previousRevision: runABucket?.revision,
      })
      expect(runEventBuckets.value.get('run-b')).toBe(runBBucket)
    }
    finally {
      sync.dispose()
    }
  })

  it('coalesces same-scope refreshes requested while a snapshot is in flight', async () => {
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    const firstPage = deferred<LocalConversationTimelinePage>()
    let requestCount = 0
    const api = createApi({
      listTimeline: async () => {
        requestCount += 1
        if (requestCount === 1)
          return firstPage.promise
        return timelinePage([
          timelineMessage('message-new', 'conversation-a', 'branch-conversation-a', 2),
        ], null, [run('run-a', 'conversation-a')])
      },
    })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })

    const firstRefresh = sync.refreshActiveConversation()
    await vi.waitUntil(() => vi.mocked(api.conversations.listTimeline).mock.calls.length === 1)
    const secondRefresh = sync.refreshActiveConversation()
    const thirdRefresh = sync.refreshActiveConversation()

    expect(api.conversations.listTimeline).toHaveBeenCalledTimes(1)
    firstPage.resolve(timelinePage([
      timelineMessage('message-old', 'conversation-a', 'branch-conversation-a', 1),
    ], null, [run('run-a', 'conversation-a')]))
    await Promise.all([firstRefresh, secondRefresh, thirdRefresh])

    expect(api.conversations.listTimeline).toHaveBeenCalledTimes(2)
    expect(sync.messages.value.map(item => item.id)).toEqual(['message-old', 'message-new'])
  })

  it('starts a fresh snapshot when the same scope resets during an older flight', async () => {
    vi.stubGlobal('window', { clearTimeout, setTimeout })
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    const stalePage = deferred<LocalConversationTimelinePage>()
    let requestCount = 0
    const api = createApi({
      listTimeline: async () => {
        requestCount += 1
        if (requestCount === 2)
          return stalePage.promise
        const messageId = requestCount === 1 ? 'message-old' : 'message-replacement'
        return timelinePage([
          timelineMessage(messageId, 'conversation-a', 'branch-conversation-a', requestCount),
        ], null, [run('run-a', 'conversation-a')])
      },
    })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })

    try {
      await sync.refreshActiveConversation()
      const staleRefresh = sync.refreshActiveConversation()
      await vi.waitUntil(() => vi.mocked(api.conversations.listTimeline).mock.calls.length === 2)
      sync.applyEditedTurn({
        branchId: 'branch-conversation-a',
        conversationId: 'conversation-a',
        draftReceipt: null,
        run: run('run-replacement', 'conversation-a'),
        runId: 'run-replacement',
      }, 'message-old')
      await sync.refreshActiveConversation()
      stalePage.resolve(timelinePage([
        timelineMessage('message-stale', 'conversation-a', 'branch-conversation-a', 2),
      ], null, [run('run-a', 'conversation-a')]))
      await staleRefresh

      expect(api.conversations.listTimeline).toHaveBeenCalledTimes(3)
      expect(sync.messages.value.map(item => item.id)).toEqual(['message-replacement'])
    }
    finally {
      sync.dispose()
    }
  })

  it('replaces compacted events when an active run becomes terminal', async () => {
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    let requestCount = 0
    const api = createApi({
      listTimeline: async () => {
        requestCount += 1
        const active = run('run-a', 'conversation-a')
        const currentRun = requestCount === 1
          ? active
          : { ...active, completedAt: '2026-08-14T00:00:03.000Z', status: 'completed' as const }
        return timelinePage(
          [timelineMessage('message-a', 'conversation-a', 'branch-conversation-a', 1)],
          null,
          [currentRun],
          requestCount === 1
            ? [event('run-a', 1), event('run-a', 2)]
            : [event('run-a', 3)],
        )
      },
    })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })

    await sync.refreshActiveConversation()
    await sync.refreshActiveConversation()

    expect(sync.runEventBuckets.value.get('run-a')?.events.map(item => item.sequence)).toEqual([3])
  })

  it('refreshes the final message when a terminal event follows a stale terminal snapshot', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { clearTimeout, setTimeout })
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    const activeRun = run('run-a', 'conversation-a')
    const completedRun = {
      ...activeRun,
      completedAt: '2026-08-14T00:00:03.000Z',
      status: 'completed' as const,
    }
    let requestCount = 0
    const api = createApi({
      listTimeline: async () => {
        requestCount += 1
        return timelinePage([
          timelineMessage('message-a', 'conversation-a', 'branch-conversation-a', 1),
          ...(requestCount >= 3
            ? [timelineMessage(
                'assistant-a',
                'conversation-a',
                'branch-conversation-a',
                3,
                'assistant',
              )]
            : []),
        ], null, [requestCount === 1 ? activeRun : completedRun])
      },
    })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })

    try {
      await sync.refreshActiveConversation()
      await sync.refreshActiveConversation()
      expect(sync.messages.value.map(item => item.id)).toEqual(['message-a'])

      sync.handleRunEvent({ ...event('run-a', 2), type: 'run.completed' })
      await vi.advanceTimersByTimeAsync(100)

      expect(api.conversations.listTimeline).toHaveBeenCalledTimes(3)
      expect(sync.messages.value.map(item => item.id)).toEqual(['message-a', 'assistant-a'])
    }
    finally {
      sync.dispose()
      vi.useRealTimers()
    }
  })

  it('prepends older cursor pages in chronological order without duplicating boundaries', async () => {
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    const api = createApi({
      listEvents: async () => [],
      listTimeline: async input => input.cursor
        ? timelinePage([
            timelineMessage('message-1', 'conversation-a', 'branch-conversation-a', 1),
            compaction('compact-1', 'conversation-a', 'branch-conversation-a', 2),
            timelineMessage('message-2', 'conversation-a', 'branch-conversation-a', 3),
          ], null)
        : timelinePage([
            timelineMessage('message-3', 'conversation-a', 'branch-conversation-a', 4),
            timelineMessage('message-4', 'conversation-a', 'branch-conversation-a', 5),
          ], 'cursor-before-message-3'),
    })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })

    await sync.refreshActiveConversation()
    expect(sync.hasOlderMessages.value).toBe(true)
    await expect(sync.loadOlderMessages()).resolves.toBe(true)

    expect(api.conversations.listTimeline).toHaveBeenLastCalledWith({
      branchId: 'branch-conversation-a',
      conversationId: 'conversation-a',
      cursor: 'cursor-before-message-3',
      limit: 100,
    })
    expect(sync.messages.value.map(item => item.id))
      .toEqual(['message-1', 'message-2', 'message-3', 'message-4'])
    expect(sync.timelineItems.value.map(item => `${item.kind}:${item.id}`)).toEqual([
      'message:message-1',
      'compaction:compact-1',
      'message:message-2',
      'message:message-3',
      'message:message-4',
    ])
    expect(sync.hasOlderMessages.value).toBe(false)
  })

  it('merges older event pages from the full run buckets', async () => {
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    const api = createApi({
      listTimeline: async input => input.cursor
        ? timelinePage([], null, [], [event('run-a', 1)])
        : timelinePage(
            [timelineMessage('message-2', 'conversation-a', 'branch-conversation-a', 2)],
            'cursor-before-message-2',
            [run('run-a', 'conversation-a')],
            [event('run-a', 2)],
          ),
    })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })

    await sync.refreshActiveConversation()
    await sync.loadOlderMessages()

    expect(sync.runEventBuckets.value.get('run-a')?.events.map(item => item.sequence))
      .toEqual([1, 2])
  })

  it('merges a tail refresh without discarding previously loaded history or reopening its cursor', async () => {
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-conversation-a')
    let newestRequestCount = 0
    const api = createApi({
      listEvents: async () => [],
      listTimeline: async (input) => {
        if (input.cursor) {
          return timelinePage([
            timelineMessage('message-1', 'conversation-a', 'branch-conversation-a', 1),
            timelineMessage('message-2', 'conversation-a', 'branch-conversation-a', 2),
          ], null)
        }
        newestRequestCount += 1
        return timelinePage([
          timelineMessage('message-3', 'conversation-a', 'branch-conversation-a', 3),
          timelineMessage('message-4', 'conversation-a', 'branch-conversation-a', 4),
          ...(newestRequestCount > 1
            ? [timelineMessage('message-5', 'conversation-a', 'branch-conversation-a', 5)]
            : []),
        ], 'cursor-before-message-3')
      },
    })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })

    await sync.refreshActiveConversation()
    await sync.loadOlderMessages()
    await sync.refreshActiveConversation()

    expect(sync.messages.value.map(item => item.id))
      .toEqual(['message-1', 'message-2', 'message-3', 'message-4', 'message-5'])
    expect(sync.hasOlderMessages.value).toBe(false)
  })

  it('drops an older page that resolves after switching to another branch', async () => {
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-a')
    const stalePage = deferred<LocalConversationTimelinePage>()
    const api = createApi({
      listEvents: async () => [],
      listTimeline: async (input) => {
        if (input.branchId === 'branch-b')
          return timelinePage([timelineMessage('message-b', 'conversation-a', 'branch-b', 10)], null)
        if (input.cursor)
          return stalePage.promise
        return timelinePage([timelineMessage('message-a', 'conversation-a', 'branch-a', 5)], 'cursor-a')
      },
    })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })

    await sync.refreshActiveConversation()
    const staleLoad = sync.loadOlderMessages()
    await vi.waitUntil(() => vi.mocked(api.conversations.listTimeline).mock.calls.length === 2)
    activeBranchId.value = 'branch-b'
    await sync.refreshActiveConversation()
    stalePage.resolve(timelinePage([
      timelineMessage('message-stale', 'conversation-a', 'branch-a', 1),
    ], null))

    await expect(staleLoad).resolves.toBe(false)
    expect(sync.messages.value.map(item => item.id)).toEqual(['message-b'])
  })

  it('trims persistent timeline events together with edit and retry boundaries', async () => {
    vi.stubGlobal('window', { clearTimeout, setTimeout })
    const activeConversationId = ref<string | null>('conversation-a')
    const activeBranchId = ref<string | null>('branch-a')
    const api = createApi({
      listEvents: async () => [],
      listTimeline: async () => timelinePage([
        timelineMessage('message-1', 'conversation-a', 'branch-a', 1),
        compaction('compact-before', 'conversation-a', 'branch-a', 2),
        timelineMessage('message-2', 'conversation-a', 'branch-a', 3),
        compaction('compact-after', 'conversation-a', 'branch-a', 4),
        timelineMessage('assistant-1', 'conversation-a', 'branch-a', 5, 'assistant'),
      ], null),
    })
    const sync = useChatRunSync({
      activeBranchId,
      activeConversationId,
      api,
      onError: vi.fn(),
    })
    await sync.refreshActiveConversation()

    activeBranchId.value = 'branch-edit'
    sync.applyEditedTurn({
      branchId: 'branch-edit',
      conversationId: 'conversation-a',
      draftReceipt: null,
      run: run('run-edited', 'conversation-a'),
      runId: 'run-edited',
    }, 'message-2')
    expect(sync.timelineItems.value.map(item => item.id)).toEqual([
      'message-1',
      'compact-before',
    ])

    activeBranchId.value = 'branch-a'
    await sync.refreshActiveConversation()
    sync.applyRegeneratedTurn({
      branchId: 'branch-a',
      conversationId: 'conversation-a',
      draftReceipt: null,
      run: {
        ...run('run-regenerated', 'conversation-a'),
        triggeringMessageId: 'message-2',
      },
      runId: 'run-regenerated',
    })
    expect(sync.timelineItems.value.map(item => item.id)).toEqual([
      'message-1',
      'compact-before',
      'message-2',
    ])
    sync.dispose()
  })

  it.each(['success', 'failure'] as const)('ignores a snapshot %s after disposal and retains the last projection', async (outcome) => {
    const pending = deferred<LocalConversationTimelinePage>()
    const initial = timelinePage([timelineMessage('saved', 'conversation-a', 'branch-a', 1)], null)
    const api = createApi({ listTimeline: async () => initial })
    const errors: unknown[] = []
    const sync = useChatRunSync({
      activeBranchId: ref('branch-a'),
      activeConversationId: ref('conversation-a'),
      api,
      onError: error => errors.push(error),
    })
    await sync.refreshActiveConversation()
    vi.mocked(api.conversations.listTimeline).mockReturnValue(pending.promise)
    const refresh = sync.refreshActiveConversation()
    const queuedRefresh = sync.refreshActiveConversation()
    sync.dispose()
    if (outcome === 'success')
      pending.resolve(timelinePage([timelineMessage('late', 'conversation-a', 'branch-a', 2)], null))
    else
      pending.reject(new Error('Late snapshot unavailable'))
    await Promise.all([refresh, queuedRefresh])
    await sync.refreshActiveConversation()
    expect(sync.messages.value.map(item => item.id)).toEqual(['saved'])
    expect(errors).toEqual([])
    expect(api.conversations.listTimeline).toHaveBeenCalledTimes(2)
  })

  it.each(['success', 'failure'] as const)('ignores an older page %s after disposal', async (outcome) => {
    const pending = deferred<LocalConversationTimelinePage>()
    const api = createApi({
      listTimeline: async input => input.cursor
        ? pending.promise
        : timelinePage([timelineMessage('tail', 'conversation-a', 'branch-a', 2)], 'older'),
    })
    const errors: unknown[] = []
    const sync = useChatRunSync({
      activeBranchId: ref('branch-a'),
      activeConversationId: ref('conversation-a'),
      api,
      onError: error => errors.push(error),
    })
    await sync.refreshActiveConversation()
    const older = sync.loadOlderMessages()
    sync.dispose()
    if (outcome === 'success')
      pending.resolve(timelinePage([timelineMessage('late', 'conversation-a', 'branch-a', 1)], null))
    else
      pending.reject(new Error('Late page unavailable'))
    await expect(older).resolves.toBe(false)
    expect(sync.messages.value.map(item => item.id)).toEqual(['tail'])
    expect(sync.hasOlderMessages.value).toBe(true)
    expect(sync.isLoadingOlderMessages.value).toBe(false)
    expect(errors).toEqual([])
  })

  it('does not reuse a request after navigating away and back before another refresh', async () => {
    const pending = deferred<LocalConversationTimelinePage>()
    const activeConversationId = ref('conversation-a')
    const activeBranchId = ref('branch-a')
    const api = createApi({ listTimeline: async () => pending.promise })
    const sync = useChatRunSync({ activeBranchId, activeConversationId, api, onError: vi.fn() })
    const stale = sync.refreshActiveConversation()
    activeConversationId.value = 'conversation-b'
    activeBranchId.value = 'branch-b'
    activeConversationId.value = 'conversation-a'
    activeBranchId.value = 'branch-a'
    vi.mocked(api.conversations.listTimeline).mockResolvedValue(
      timelinePage([timelineMessage('current', 'conversation-a', 'branch-a', 2)], null),
    )
    await sync.refreshActiveConversation()
    pending.resolve(timelinePage([timelineMessage('stale', 'conversation-a', 'branch-a', 1)], null))
    await stale
    expect(sync.messages.value.map(item => item.id)).toEqual(['current'])
    sync.dispose()
  })

  it('keeps a new branch page loading when an old page settles', async () => {
    const oldPage = deferred<LocalConversationTimelinePage>()
    const newPage = deferred<LocalConversationTimelinePage>()
    const activeBranchId = ref('branch-a')
    const api = createApi({
      listTimeline: async input => input.cursor
        ? (input.branchId === 'branch-a' ? oldPage.promise : newPage.promise)
        : timelinePage([timelineMessage(input.branchId!, 'conversation-a', input.branchId!, 2)], 'older'),
    })
    const sync = useChatRunSync({ activeBranchId, activeConversationId: ref('conversation-a'), api, onError: vi.fn() })
    await sync.refreshActiveConversation()
    const oldLoad = sync.loadOlderMessages()
    activeBranchId.value = 'branch-b'
    await sync.refreshActiveConversation()
    const newLoad = sync.loadOlderMessages()
    oldPage.resolve(timelinePage([timelineMessage('stale', 'conversation-a', 'branch-a', 1)], null))
    await expect(oldLoad).resolves.toBe(false)
    expect(sync.messages.value.map(item => item.id)).toEqual(['branch-b'])
    expect(sync.isLoadingOlderMessages.value).toBe(true)
    newPage.resolve(timelinePage([timelineMessage('older-b', 'conversation-a', 'branch-b', 1)], null))
    await expect(newLoad).resolves.toBe(true)
    expect(sync.messages.value.map(item => item.id)).toEqual(['older-b', 'branch-b'])
    expect(sync.isLoadingOlderMessages.value).toBe(false)
    sync.dispose()
  })

  it('releases pending events, scheduled refresh and late responses with its Vue scope', async () => {
    vi.useFakeTimers()
    const animationFrames = stubAnimationFrameWindow()
    const pending = deferred<LocalConversationTimelinePage>()
    const scope = effectScope()
    const api = createApi({ listEvents: async () => [] })
    const sync = scope.run(() => useChatRunSync({
      activeBranchId: ref('branch-conversation-a'),
      activeConversationId: ref('conversation-a'),
      api,
      onError: vi.fn(),
    }))!
    try {
      await sync.refreshActiveConversation()
      sync.handleRunEvent({ ...event('run-a', 1), type: 'run.completed' })
      sync.handleRunEvent({ ...event('run-a', 2), type: 'message.delta' })
      vi.mocked(api.conversations.listTimeline).mockReturnValue(pending.promise)
      const refresh = sync.refreshActiveConversation()
      scope.stop()
      animationFrames.flush()
      pending.resolve(timelinePage([timelineMessage('late', 'conversation-a', 'branch-conversation-a', 1)], null))
      await refresh
      sync.handleRunEvent(event('run-a', 3))
      sync.upsertRuns([run('after-dispose', 'conversation-a')])
      await vi.advanceTimersByTimeAsync(500)
      expect(sync.messages.value.map(item => item.id)).toEqual(['message-conversation-a'])
      expect(sync.runs.value.map(item => item.id)).toEqual(['run-a'])
      expect(sync.runEventBuckets.value.get('run-a')?.events.map(item => item.sequence)).toEqual([1])
      expect(api.conversations.listTimeline).toHaveBeenCalledTimes(2)
    }
    finally {
      scope.stop()
      vi.useRealTimers()
    }
  })

  it('updates runs in the current lineage without inserting results from another branch or task', async () => {
    const ancestorRun = { ...run('ancestor', 'conversation-a'), branchId: 'branch-parent' }
    const api = createApi({
      listTimeline: async () => timelinePage([], null, [ancestorRun]),
    })
    const sync = useChatRunSync({
      activeBranchId: ref('branch-child'),
      activeConversationId: ref('conversation-a'),
      api,
      onError: vi.fn(),
    })
    await sync.refreshActiveConversation()
    sync.upsertRuns([
      { ...ancestorRun, status: 'completed' },
      { ...run('other-branch', 'conversation-a'), branchId: 'branch-other' },
      run('other-task', 'conversation-b'),
    ])
    expect(sync.runs.value.map(item => [item.id, item.status])).toEqual([['ancestor', 'completed']])
    sync.dispose()
  })
})

function createApi(options: {
  listEvents?: (conversationId: string) => Promise<ReadonlyArray<LocalRunEvent>>
  listTimeline?: (input: {
    branchId?: string
    conversationId: string
    cursor?: string
    limit?: number
  }) => Promise<LocalConversationTimelinePage>
}) {
  const listEvents = vi.fn((input: { conversationId: string }) => (
    options.listEvents?.(input.conversationId) ?? Promise.resolve([])
  ))
  const api = {
    approvals: {
      list: vi.fn(async () => []),
    },
    conversations: {
      listTimeline: vi.fn(async (input: {
        branchId?: string
        conversationId: string
        cursor?: string
        limit?: number
      }) => options.listTimeline?.(input) ?? Promise.resolve(options.listEvents?.(input.conversationId) ?? [])
        .then(runEvents => timelinePage([
          timelineMessage(
            `message-${input.conversationId}`,
            input.conversationId,
            input.branchId ?? `branch-${input.conversationId}`,
            1,
          ),
        ], null, [run(input.conversationId === 'conversation-a' ? 'run-a' : 'run-b', input.conversationId)], runEvents))),
    },
    runs: {
      list: vi.fn(async ({ conversationId }: { conversationId: string }) => [
        run(conversationId === 'conversation-a' ? 'run-a' : 'run-b', conversationId),
      ]),
      listEvents,
    },
  } as unknown as LocalChatApi
  return Object.assign(api, {
    runs: Object.assign(api.runs, { listEvents }),
  }) as LocalChatApi & { runs: { listEvents: ReturnType<typeof vi.fn> } }
}

function timelinePage(
  items: ReadonlyArray<LocalConversationTimelineItem>,
  nextCursor: string | null,
  runs: ReadonlyArray<LocalRun> = [],
  runEvents: ReadonlyArray<LocalRunEvent> = [],
  outputs: ReadonlyArray<LocalRunOutput> = [],
): LocalConversationTimelinePage {
  return { changeSets: [], items, nextCursor, outputs, runEvents, runs }
}

function timelineMessage(
  id: string,
  conversationId: string,
  branchId: string,
  second: number,
  role: LocalMessage['role'] = 'user',
): Extract<LocalConversationTimelineItem, { kind: 'message' }> {
  return { ...message(id, conversationId, branchId, second, role), kind: 'message' }
}

function message(
  id: string,
  conversationId: string,
  branchId: string,
  second: number,
  role: LocalMessage['role'] = 'user',
): LocalMessage {
  return {
    attachments: [],
    branchId,
    content: { text: id },
    conversationId,
    createdAt: `2026-08-14T00:00:${second.toString().padStart(2, '0')}.000Z`,
    id,
    role,
    runId: null,
  }
}

function compaction(
  id: string,
  conversationId: string,
  branchId: string,
  second: number,
): Extract<LocalConversationTimelineItem, { kind: 'compaction' }> {
  const createdAt = `2026-08-14T00:00:${second.toString().padStart(2, '0')}.000Z`
  return {
    branchId,
    completedAt: createdAt,
    conversationId,
    createdAt,
    errorCode: null,
    estimatedTokensAfter: 700,
    id,
    kind: 'compaction',
    status: 'completed',
    tokensBefore: 1400,
  }
}

function run(id: string, conversationId: string): LocalRun {
  return {
    branchId: `branch-${conversationId}`,
    completedAt: null,
    conversationId,
    errorCode: null,
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write',
    id,
    modelId: 'model-1',
    providerId: 'provider-1',
    purpose: 'chat',
    reasoningLevel: null,
    startedAt: '2026-08-14T00:00:00.000Z',
    status: 'running',
    triggeringMessageId: `message-${conversationId}`,
  }
}

function event(runId: string, sequence: number): LocalRunEvent {
  return {
    createdAt: '2026-08-14T00:00:01.000Z',
    payload: {},
    runId,
    sequence,
    type: 'run.started',
  }
}

function stubAnimationFrameWindow() {
  const callbacks = new Map<number, FrameRequestCallback>()
  let nextFrameId = 0
  vi.stubGlobal('window', {
    cancelAnimationFrame(frameId: number) {
      callbacks.delete(frameId)
    },
    clearTimeout,
    requestAnimationFrame(callback: FrameRequestCallback) {
      const frameId = ++nextFrameId
      callbacks.set(frameId, callback)
      return frameId
    },
    setTimeout,
  })
  return {
    flush() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending)
        callback(0)
    },
    size: () => callbacks.size,
  }
}
