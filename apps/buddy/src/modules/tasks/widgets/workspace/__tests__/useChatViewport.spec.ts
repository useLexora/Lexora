import type { BuddyChatMessageListHandle, ChatMessageScrollAnchor, ChatMessageScrollMetrics, ChatReadingPositions } from '../../transcript/chatMessageViewport'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useChatViewport } from '../useChatViewport'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function createList() {
  const metrics: ChatMessageScrollMetrics = { clientHeight: 400, scrollHeight: 1_000, scrollTop: 20 }
  const highlights: string[] = []
  const revealed: string[] = []
  const revealBehaviors: Array<ScrollBehavior | undefined> = []
  const geometry = { anchorTop: 20 }
  const handle: BuddyChatMessageListHandle = {
    captureScrollAnchor: () => ({ messageId: 'visible', messageOffsetTop: geometry.anchorTop - metrics.scrollTop, metrics: { ...metrics } }),
    highlightMessage: id => highlights.push(id),
    readScrollMetrics: () => ({ ...metrics }),
    restoreScrollAnchor: (anchor: ChatMessageScrollAnchor) => {
      metrics.scrollTop = geometry.anchorTop - anchor.messageOffsetTop
      return { ...metrics }
    },
    scrollToMessage: (id, behavior) => {
      revealed.push(id)
      revealBehaviors.push(behavior)
      metrics.scrollTop = id === 'new-target' ? 300 : 100
      return { ...metrics }
    },
    scrollToTail: () => {
      metrics.scrollTop = metrics.scrollHeight - metrics.clientHeight
      return { ...metrics }
    },
  }
  return { geometry, handle, highlights, metrics, revealed, revealBehaviors }
}

function createViewport(loadOlderMessages: () => Promise<boolean>, initial: {
  isLoading?: boolean
  listMounted?: boolean
  revealMessageId?: string
  readingPositions?: ChatReadingPositions
} = {}) {
  const original = createList()
  const options = {
    readingPositions: initial.readingPositions,
    activeBranchId: shallowRef<string | null>('branch-1'),
    activeConversationId: shallowRef<string | null>('conversation-1'),
    revealMessageId: shallowRef<string | null>(initial.revealMessageId ?? null),
    hasOlderMessages: shallowRef(true),
    isLoading: shallowRef(initial.isLoading ?? false),
    isLoadingOlderMessages: shallowRef(false),
    list: shallowRef<BuddyChatMessageListHandle | null>(initial.listMounted === false ? null : original.handle),
    loadOlderMessages,
    timelineItems: shallowRef<{ id: string, kind: string }[]>([{ id: 'visible', kind: 'message' }]),
  }
  const scope = effectScope()
  const viewport = scope.run(() => useChatViewport(options))!
  cleanups.push(() => scope.stop())
  return { options, original, scope, viewport }
}

type Invalidation = 'conversation' | 'branch' | 'list' | 'dispose'
async function prependHistory(fixture: ReturnType<typeof createViewport>, height = 400) {
  fixture.options.timelineItems.value = [{ id: 'older', kind: 'message' }, ...fixture.options.timelineItems.value]
  await nextTick()
  fixture.original.metrics.scrollHeight += height
  fixture.original.geometry.anchorTop += height
  await nextTick()
}

async function invalidate(fixture: ReturnType<typeof createViewport>, reason: Invalidation) {
  let current = fixture.original
  if (reason === 'conversation') {
    fixture.options.activeConversationId.value = 'conversation-2'
    fixture.options.activeConversationId.value = 'conversation-1'
  }
  else if (reason === 'branch') {
    fixture.options.activeBranchId.value = 'branch-2'
  }
  else if (reason === 'list') {
    current = createList()
    fixture.options.list.value = current.handle
  }
  else {
    fixture.scope.stop()
  }
  await nextTick()
  await nextTick()
  current.metrics.scrollTop = 150
  fixture.original.metrics.scrollTop = 150
  return current
}

describe('chat viewport operations', () => {
  it('restores a disposed task from its lightweight anchor after loading the required history', async () => {
    const readingPositions: ChatReadingPositions = new Map()
    const first = createViewport(async () => false, { readingPositions })
    first.options.hasOlderMessages.value = false
    first.options.timelineItems.value = [{ id: 'oldest', kind: 'message' }, { id: 'visible', kind: 'message' }]
    first.original.metrics.scrollTop = 200
    first.viewport.handleScroll(first.original.metrics)
    first.scope.stop()

    let loaded = 0
    const reopened = createViewport(async () => {
      loaded += 1
      await prependHistory(reopened)
      reopened.options.timelineItems.value = [{ id: 'oldest', kind: 'message' }, ...reopened.options.timelineItems.value]
      return true
    }, { listMounted: false, readingPositions })
    reopened.options.list.value = reopened.original.handle
    for (let tick = 0; tick < 10; tick += 1)
      await nextTick()
    expect(loaded).toBe(1)
    expect(reopened.original.metrics.scrollTop).toBe(600)
    expect(reopened.viewport.isPositioning.value).toBe(false)
    expect(reopened.viewport.showReturnToLatest.value).toBe(true)
    await reopened.viewport.returnToLatest()
    reopened.scope.stop()
    expect(readingPositions.get('conversation-1:branch-1')).toBeNull()
  })

  it('fills an initially unscrollable transcript before revealing its latest position', async () => {
    let pages = 0
    const fixture = createViewport(async () => {
      pages += 1
      fixture.original.metrics.scrollHeight += 150
      fixture.options.timelineItems.value = [{ id: `older-${pages}`, kind: 'message' }, ...fixture.options.timelineItems.value]
      return true
    }, { isLoading: true, listMounted: false })
    fixture.original.metrics.scrollHeight = 200
    fixture.options.list.value = fixture.original.handle
    fixture.options.isLoading.value = false
    for (let tick = 0; tick < 6; tick += 1)
      await nextTick()

    expect(pages).toBe(2)
    expect(fixture.original.metrics.scrollHeight).toBe(500)
    expect(fixture.original.metrics.scrollTop).toBe(100)
    expect(fixture.viewport.isPositioning.value).toBe(false)
    expect(fixture.viewport.showReturnToLatest.value).toBe(false)
  })

  it('anchors prepended history to the latest reader position while a request is pending', async () => {
    const pending = deferred<boolean>()
    const fixture = createViewport(() => pending.promise)
    fixture.viewport.handleScroll(fixture.original.metrics)
    fixture.original.metrics.scrollTop = 5
    fixture.viewport.handleScroll(fixture.original.metrics)
    await prependHistory(fixture)
    pending.resolve(true)
    await nextTick()

    expect(fixture.original.metrics.scrollTop).toBe(405)
    fixture.original.geometry.anchorTop += 80
    fixture.original.metrics.scrollHeight += 80
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(485)
  })

  it('restores a recent task reading position before showing a remounted transcript', async () => {
    const fixture = createViewport(async () => false)
    fixture.original.metrics.scrollTop = 250
    fixture.viewport.handleScroll(fixture.original.metrics)
    fixture.options.activeConversationId.value = 'conversation-2'
    fixture.options.activeBranchId.value = 'branch-2'
    await nextTick()
    await nextTick()
    expect(fixture.original.metrics.scrollTop).toBe(600)

    fixture.options.isLoading.value = true
    fixture.options.activeConversationId.value = 'conversation-1'
    fixture.options.activeBranchId.value = 'branch-1'
    fixture.options.list.value = null
    await nextTick()
    expect(fixture.viewport.isPositioning.value).toBe(true)
    fixture.options.isLoading.value = false
    fixture.options.list.value = fixture.original.handle
    await nextTick()
    await nextTick()

    expect(fixture.original.metrics.scrollTop).toBe(250)
    expect(fixture.viewport.isPositioning.value).toBe(false)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)
  })

  it('releases positioning when loading a notification target fails', async () => {
    const fixture = createViewport(async () => {
      throw new Error('unavailable')
    }, {
      isLoading: true,
      listMounted: false,
      revealMessageId: 'old-target',
    })
    fixture.options.list.value = fixture.original.handle
    fixture.options.isLoading.value = false
    await nextTick()
    await nextTick()
    await nextTick()
    expect(fixture.viewport.isPositioning.value).toBe(false)
  })

  it('accepts an initial notification target and loads its history after the list becomes ready', async () => {
    let pages = 0
    const fixture = createViewport(async () => {
      pages += 1
      fixture.options.timelineItems.value = [{ id: 'new-target', kind: 'message' }]
      return true
    }, { isLoading: true, listMounted: false, revealMessageId: 'new-target' })
    await nextTick()
    expect(pages).toBe(0)
    fixture.options.isLoading.value = false
    fixture.options.list.value = fixture.original.handle
    await nextTick()
    await nextTick()
    await nextTick()

    expect(pages).toBe(1)
    expect(fixture.original.revealed).toEqual(['new-target'])
    expect(fixture.original.metrics.scrollTop).toBe(300)
  })

  it.each(['before', 'after'] as const)('reveals a target received before the list mounts %s initial loading finishes', async (mountOrder) => {
    const fixture = createViewport(async () => false)
    fixture.options.hasOlderMessages.value = false
    fixture.options.isLoading.value = true
    fixture.options.list.value = null
    fixture.options.revealMessageId.value = 'new-target'
    await nextTick()

    const mounted = createList()
    if (mountOrder === 'before') {
      fixture.options.list.value = mounted.handle
      await nextTick()
      expect(mounted.revealed).toEqual([])
    }
    fixture.options.timelineItems.value = [{ id: 'new-target', kind: 'message' }]
    fixture.options.isLoading.value = false
    await nextTick()
    if (mountOrder === 'after')
      fixture.options.list.value = mounted.handle
    await nextTick()
    await nextTick()

    expect(fixture.original.revealed).toEqual([])
    expect(mounted.revealed).toEqual(['new-target'])
    expect(mounted.metrics.scrollTop).toBe(300)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)
  })

  it('reveals the current target on a replacement list without reviving an old outline request', async () => {
    const pending = deferred<boolean>()
    const fixture = createViewport(() => pending.promise)
    const oldReveal = fixture.viewport.revealOutlineMessage('old-target')
    fixture.options.activeConversationId.value = 'conversation-2'
    fixture.options.activeBranchId.value = 'branch-2'
    fixture.options.list.value = null
    fixture.options.hasOlderMessages.value = false
    fixture.options.revealMessageId.value = 'new-target'
    await nextTick()
    const replacement = createList()
    fixture.options.timelineItems.value = [{ id: 'new-target', kind: 'message' }]
    fixture.options.list.value = replacement.handle
    await nextTick()
    pending.resolve(true)
    await oldReveal
    await nextTick()

    expect(fixture.original.highlights).toEqual([])
    expect(fixture.original.revealed).toEqual([])
    expect(replacement.highlights).toEqual([])
    expect(replacement.revealed).toEqual(['new-target'])
    expect(replacement.metrics.scrollTop).toBe(300)
  })

  it.each(['conversation', 'branch', 'reader-scroll', 'reader-layout', 'return-latest', 'clear-target', 'dispose'] as const)('cancels a pending reveal after %s instead of replaying it when the list mounts', async (reason) => {
    let pages = 0
    const fixture = createViewport(async () => {
      pages += 1
      return false
    }, { isLoading: true, listMounted: false, revealMessageId: 'old-target' })
    if (reason === 'conversation')
      fixture.options.activeConversationId.value = 'conversation-2'
    else if (reason === 'branch')
      fixture.options.activeBranchId.value = 'branch-2'
    else if (reason === 'reader-scroll')
      fixture.viewport.handleScroll({ ...fixture.original.metrics, scrollTop: 250 })
    else if (reason === 'reader-layout')
      fixture.viewport.handleReaderLayoutIntent()
    else if (reason === 'return-latest')
      await fixture.viewport.returnToLatest()
    else if (reason === 'clear-target')
      fixture.options.revealMessageId.value = null
    else
      fixture.scope.stop()
    const mounted = createList()
    fixture.options.list.value = mounted.handle
    fixture.options.isLoading.value = false
    await nextTick()
    await nextTick()

    expect(pages).toBe(0)
    expect(mounted.revealed).toEqual([])
    expect(mounted.highlights).toEqual([])
    fixture.options.revealMessageId.value = null
  })

  it.each<Invalidation>(['conversation', 'branch', 'list', 'dispose'])('discards an old pagination anchor after %s invalidation', async (reason) => {
    const pending = deferred<boolean>()
    const fixture = createViewport(() => pending.promise)
    fixture.viewport.handleScroll(fixture.original.metrics)
    const current = await invalidate(fixture, reason)
    fixture.original.metrics.scrollHeight = 1_400
    current.metrics.scrollHeight = 1_400
    pending.resolve(true)
    await nextTick()
    await nextTick()

    expect(fixture.original.metrics.scrollTop).toBe(150)
    expect(current.metrics.scrollTop).toBe(150)
  })

  it.each<Invalidation>(['conversation', 'branch', 'list', 'dispose'])('discards old outline paging, highlighting and scrolling after %s invalidation', async (reason) => {
    const pending = deferred<boolean>()
    const fixture = createViewport(() => pending.promise)
    const revealing = fixture.viewport.revealOutlineMessage('old-target')
    const current = await invalidate(fixture, reason)
    fixture.options.hasOlderMessages.value = false
    pending.resolve(true)
    await revealing

    expect(fixture.original.highlights).toEqual([])
    expect(fixture.original.revealed).toEqual([])
    expect(current.highlights).toEqual([])
    expect(current.revealed).toEqual([])
    expect(current.metrics.scrollTop).toBe(150)
  })

  it('restores the current history anchor once without following appended content', async () => {
    const pending = deferred<boolean>()
    let requests = 0
    const fixture = createViewport(() => {
      requests += 1
      return pending.promise
    })
    fixture.viewport.handleScroll(fixture.original.metrics)
    fixture.viewport.handleScroll(fixture.original.metrics)
    await prependHistory(fixture)
    pending.resolve(true)
    await nextTick()
    await nextTick()

    expect(requests).toBe(1)
    expect(fixture.original.metrics.scrollTop).toBe(420)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)
    fixture.original.metrics.scrollHeight = 1_500
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(420)
  })

  it('keeps only the latest outline target when two reveals wait for the same render', async () => {
    const fixture = createViewport(async () => false)
    fixture.options.hasOlderMessages.value = false
    const first = fixture.viewport.revealOutlineMessage('old-target')
    const second = fixture.viewport.revealOutlineMessage('new-target')
    await Promise.all([first, second])

    expect(fixture.original.highlights).toEqual(['new-target'])
    expect(fixture.original.revealed).toEqual(['new-target'])
    expect(fixture.original.metrics.scrollTop).toBe(300)
    expect(fixture.original.revealBehaviors).toEqual(['smooth'])
  })

  it('lets a new outline intent await the current history request instead of treating busy as exhausted history', async () => {
    const pending = deferred<boolean>()
    let requests = 0
    const fixture = createViewport(() => ++requests === 1 ? pending.promise : Promise.resolve(false))
    fixture.viewport.handleScroll(fixture.original.metrics)
    const first = fixture.viewport.revealOutlineMessage('old-target')
    const second = fixture.viewport.revealOutlineMessage('new-target')
    fixture.options.timelineItems.value = [{ id: 'new-target', kind: 'message' }]
    pending.resolve(true)
    await Promise.all([first, second])

    expect(requests).toBe(1)
    expect(fixture.original.highlights).toEqual(['new-target'])
    expect(fixture.original.revealed).toEqual(['new-target'])
    expect(fixture.original.metrics.scrollTop).toBe(300)
    expect(fixture.original.revealBehaviors).toEqual(['auto'])
  })

  it('lets reader movement interrupt a deferred return to the latest message', async () => {
    const fixture = createViewport(async () => false)
    fixture.options.hasOlderMessages.value = false
    fixture.original.metrics.scrollTop = 500
    fixture.viewport.handleScroll(fixture.original.metrics)
    fixture.viewport.handleReaderLayoutIntent()
    const returning = fixture.viewport.returnToLatest()
    fixture.original.metrics.scrollTop = 450
    fixture.viewport.handleScroll(fixture.original.metrics)
    await returning

    expect(fixture.original.metrics.scrollTop).toBe(450)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)
  })

  it('lets returning to latest supersede a pending history anchor', async () => {
    const pending = deferred<boolean>()
    const fixture = createViewport(() => pending.promise)
    fixture.viewport.handleScroll(fixture.original.metrics)
    await fixture.viewport.returnToLatest()
    fixture.original.metrics.scrollHeight = 1_400
    fixture.viewport.handleContentResize(fixture.original.metrics)
    pending.resolve(true)
    await nextTick()
    await nextTick()

    expect(fixture.original.metrics.scrollTop).toBe(1_000)
    expect(fixture.viewport.showReturnToLatest.value).toBe(false)
  })

  it('does not touch the list when a scheduled tail write outlives its scope', async () => {
    const fixture = createViewport(async () => false)
    fixture.original.metrics.scrollTop = 150
    const returning = fixture.viewport.returnToLatest()
    fixture.scope.stop()
    await returning
    fixture.viewport.handleContentResize(fixture.original.metrics)

    expect(fixture.original.metrics.scrollTop).toBe(150)
  })

  it('keeps following when shrinking content leaves nothing to scroll', async () => {
    const fixture = createViewport(async () => false)
    fixture.original.metrics.scrollTop = 500
    fixture.viewport.handleScroll(fixture.original.metrics)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)

    fixture.original.metrics.scrollHeight = 400
    fixture.original.metrics.scrollTop = 0
    fixture.viewport.handleContentResize(fixture.original.metrics)

    expect(fixture.original.metrics.scrollTop).toBe(0)
    expect(fixture.viewport.showReturnToLatest.value).toBe(false)
  })

  it('ignores a reader layout intent while the transcript cannot scroll', async () => {
    const fixture = createViewport(async () => false)
    fixture.original.metrics.scrollHeight = 400
    fixture.original.metrics.scrollTop = 0
    fixture.viewport.handleReaderLayoutIntent()

    expect(fixture.viewport.showReturnToLatest.value).toBe(false)
  })

  it('keeps reader ownership when only the list owner is replaced', async () => {
    const fixture = createViewport(async () => false)
    fixture.viewport.handleReaderLayoutIntent()
    const replacement = createList()
    replacement.metrics.scrollTop = 250
    fixture.options.list.value = replacement.handle
    await nextTick()
    fixture.viewport.handleContentResize(replacement.metrics)

    expect(replacement.metrics.scrollTop).toBe(250)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)
  })

  it('loads enough history to reveal the requested message and keeps following disabled', async () => {
    let pages = 0
    const fixture = createViewport(async () => {
      pages += 1
      fixture.options.timelineItems.value = [{ id: pages === 1 ? 'middle' : 'old-target', kind: 'message' }]
      return true
    })
    await fixture.viewport.revealOutlineMessage('old-target')

    expect(pages).toBe(2)
    expect(fixture.original.highlights).toEqual(['old-target'])
    expect(fixture.original.metrics.scrollTop).toBe(100)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)
  })

  it('lets a reader layout change cancel an outline request while history is loading', async () => {
    const pending = deferred<boolean>()
    const fixture = createViewport(() => pending.promise)
    const revealing = fixture.viewport.revealOutlineMessage('old-target')
    fixture.original.metrics.scrollTop = 250
    fixture.viewport.handleReaderLayoutIntent()
    fixture.options.hasOlderMessages.value = false
    pending.resolve(true)
    await revealing

    expect(fixture.original.highlights).toEqual([])
    expect(fixture.original.metrics.scrollTop).toBe(250)
  })

  it('releases a failed history request so the next scroll can retry and restore its anchor', async () => {
    const failed = deferred<boolean>()
    const retry = deferred<boolean>()
    let requests = 0
    const fixture = createViewport(() => ++requests === 1 ? failed.promise : retry.promise)
    fixture.viewport.handleScroll(fixture.original.metrics)
    failed.reject(new Error('History temporarily unavailable'))
    await nextTick()
    fixture.original.metrics.scrollTop = 19
    fixture.viewport.handleScroll(fixture.original.metrics)
    await prependHistory(fixture)
    retry.resolve(true)
    await nextTick()
    await nextTick()

    expect(requests).toBe(2)
    expect(fixture.original.metrics.scrollTop).toBe(419)
  })

  it('starts paging in the new branch without letting the old request clear its pending state', async () => {
    const oldPage = deferred<boolean>()
    const newPage = deferred<boolean>()
    let requests = 0
    const fixture = createViewport(() => ++requests === 1 ? oldPage.promise : newPage.promise)
    fixture.viewport.handleScroll(fixture.original.metrics)
    fixture.options.activeBranchId.value = 'branch-2'
    await nextTick()
    await nextTick()
    fixture.original.metrics.scrollTop = 20
    fixture.viewport.handleScroll(fixture.original.metrics)
    oldPage.resolve(true)
    await nextTick()
    await nextTick()
    fixture.viewport.handleScroll(fixture.original.metrics)

    expect(requests).toBe(2)
    expect(fixture.original.metrics.scrollTop).toBe(20)
    await prependHistory(fixture)
    newPage.resolve(true)
    await nextTick()
    await nextTick()
    expect(fixture.original.metrics.scrollTop).toBe(420)
  })

  it('explicitly clears previous reading states and follows the tail on resetToTail', async () => {
    const readingPositions: ChatReadingPositions = new Map()
    const fixture = createViewport(async () => false, { readingPositions })
    fixture.options.hasOlderMessages.value = false
    fixture.original.metrics.scrollTop = 200
    fixture.viewport.handleScroll(fixture.original.metrics)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)

    fixture.viewport.resetToTail()
    expect(fixture.viewport.showReturnToLatest.value).toBe(false)
    expect(fixture.original.metrics.scrollTop).toBe(600)
    expect(readingPositions.get('conversation-1:branch-1')).toBeNull()

    // 新内容追加时保持跟随
    fixture.original.metrics.scrollHeight = 1_400
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(1_000)
  })

  it('does not detach follow ownership on non-user scrolls caused by window or split resizing', async () => {
    const fixture = createViewport(async () => false)
    fixture.options.hasOlderMessages.value = false
    // 初始处于 tail: 1000 - 400 = 600
    fixture.original.metrics.scrollTop = 600
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.viewport.showReturnToLatest.value).toBe(false)

    // 窗口或者分屏调整导致视口高度变小，且触发了非用户滚动事件
    fixture.original.metrics.clientHeight = 300
    fixture.original.metrics.scrollTop = 500 // 暂时未到达最新 tail (700)
    fixture.viewport.handleScroll(fixture.original.metrics, { userInitiated: false })

    // 不会被误认为用户主动脱离
    expect(fixture.viewport.showReturnToLatest.value).toBe(false)

    // ResizeObserver 回调触发后，立即自动跟随到最新底部
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(700)
    expect(fixture.viewport.showReturnToLatest.value).toBe(false)
  })
})
