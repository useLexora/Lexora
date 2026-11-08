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
  const geometry = { anchorTop: 20, replacementHeight: null as number | null }
  const anchorKeys = new Set(['visible'])
  const handle: BuddyChatMessageListHandle = {
    prepareTurnReplacement: () => { geometry.replacementHeight = metrics.scrollHeight },
    finishTurnReplacement: () => { geometry.replacementHeight = null },
    captureScrollAnchor: () => ({ messageId: 'visible', messageOffsetTop: geometry.anchorTop - metrics.scrollTop, metrics: { ...metrics } }),
    hasScrollAnchor: anchor => anchorKeys.has(anchor.rowKey ?? anchor.messageId),
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
  return { anchorKeys, geometry, handle, highlights, metrics, revealed, revealBehaviors }
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

type Invalidation = 'conversation' | 'branch' | 'list' | 'dispose' | 'reader-layout'
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
  else if (reason === 'reader-layout') {
    fixture.viewport.handleReaderLayoutIntent()
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
  it('inherits the reader anchor across a regeneration branch and its completion', async () => {
    const fixture = createViewport(async () => false)
    fixture.options.hasOlderMessages.value = false
    fixture.original.metrics.scrollTop = 200
    fixture.viewport.handleScroll(fixture.original.metrics, { userInitiated: true })
    fixture.viewport.prepareTurnReplacement('visible', 'replacement')
    fixture.options.activeBranchId.value = 'replacement'
    fixture.original.geometry.anchorTop += 30
    await nextTick()

    expect(fixture.original.metrics.scrollTop).toBe(230)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)
    expect(fixture.viewport.isPositioning.value).toBe(false)
    fixture.original.metrics.scrollHeight += 500
    fixture.viewport.handleContentResize(fixture.original.metrics)
    fixture.viewport.finishTurnReplacement()
    expect(fixture.original.metrics.scrollTop).toBe(230)
    expect(fixture.original.geometry.replacementHeight).toBeNull()
  })

  it('keeps following after replacement shrinkage and releases its layout on completion', async () => {
    const fixture = createViewport(async () => false)
    fixture.options.hasOlderMessages.value = false
    await fixture.viewport.returnToLatest()
    fixture.viewport.prepareTurnReplacement('visible', 'replacement')
    fixture.options.activeBranchId.value = 'replacement'
    fixture.original.metrics.scrollHeight = 800
    fixture.original.metrics.scrollTop = 400
    await nextTick()
    expect(fixture.viewport.isPositioning.value).toBe(false)
    fixture.original.metrics.scrollHeight = 1200
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(400)
    fixture.original.metrics.scrollHeight = 600
    fixture.viewport.finishTurnReplacement()
    expect(fixture.original.metrics.scrollTop).toBe(200)
    expect(fixture.viewport.showReturnToLatest.value).toBe(false)
  })

  it('discards the replacement layout and pending positioning when navigating elsewhere', async () => {
    const fixture = createViewport(async () => false)
    fixture.options.hasOlderMessages.value = false
    fixture.viewport.prepareTurnReplacement('visible', 'replacement')
    fixture.options.activeBranchId.value = 'replacement'
    fixture.options.activeConversationId.value = 'another-conversation'
    await nextTick()
    expect(fixture.original.geometry.replacementHeight).toBeNull()
    fixture.original.metrics.scrollTop = 100
    fixture.viewport.handleScroll(fixture.original.metrics, { userInitiated: true })
    fixture.viewport.finishTurnReplacement()
    expect(fixture.original.metrics.scrollTop).toBe(100)
  })

  it('leaves resize position correction to the list owner across reader, navigation and tail ownership', async () => {
    const fixture = createViewport(async () => false)
    fixture.options.hasOlderMessages.value = false
    await nextTick()
    await nextTick()
    fixture.original.metrics.scrollTop = 200
    fixture.viewport.handleScroll(fixture.original.metrics, { userInitiated: true })

    fixture.original.geometry.anchorTop += 30
    fixture.original.metrics.scrollHeight += 30
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(200)
    fixture.original.geometry.anchorTop += 240
    fixture.original.metrics.scrollHeight += 240
    fixture.viewport.handleScroll(fixture.original.metrics, { userInitiated: false })
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(200)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)

    await fixture.viewport.revealOutlineMessage('new-target')
    expect(fixture.original.revealBehaviors).toEqual(['smooth'])
    expect(fixture.original.metrics.scrollTop).toBe(300)
    fixture.original.metrics.scrollTop = 420
    fixture.viewport.handleScroll(fixture.original.metrics, { userInitiated: false })
    fixture.original.geometry.anchorTop += 50
    fixture.original.metrics.scrollHeight += 50
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(420)

    fixture.original.metrics.scrollTop = 500
    fixture.viewport.handleScroll(fixture.original.metrics, { userInitiated: true })
    fixture.original.geometry.anchorTop += 50
    fixture.original.metrics.scrollHeight += 50
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(500)
    await fixture.viewport.returnToLatest()
    const requestedTail = fixture.original.metrics.scrollHeight - fixture.original.metrics.clientHeight
    expect(fixture.original.metrics.scrollTop).toBe(requestedTail)
    expect(fixture.viewport.showReturnToLatest.value).toBe(false)
    fixture.original.metrics.scrollHeight += 100
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(requestedTail)
    expect(fixture.viewport.showReturnToLatest.value).toBe(false)
  })

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
      reopened.original.anchorKeys.add('visible')
      reopened.options.timelineItems.value = [{ id: 'oldest', kind: 'message' }, ...reopened.options.timelineItems.value]
      return true
    }, { listMounted: false, readingPositions })
    reopened.original.anchorKeys.clear()
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

  it('restores an available anchor without reloading previously visited history', async () => {
    const readingPositions: ChatReadingPositions = new Map()
    const first = createViewport(async () => false, { readingPositions })
    first.options.hasOlderMessages.value = false
    first.options.timelineItems.value = [{ id: 'oldest', kind: 'message' }, { id: 'visible', kind: 'message' }]
    first.original.metrics.scrollTop = 200
    first.viewport.handleScroll(first.original.metrics)
    first.scope.stop()

    const reopened = createViewport(async () => {
      throw new Error('Available anchors do not need another page')
    }, { readingPositions, listMounted: false })
    reopened.options.list.value = reopened.original.handle
    await nextTick()
    await nextTick()

    expect(reopened.original.metrics.scrollTop).toBe(200)
    expect(reopened.options.timelineItems.value.map(item => item.id)).toEqual(['visible'])
    expect(reopened.viewport.isRestoringPosition.value).toBe(false)
    expect(reopened.viewport.showReturnToLatest.value).toBe(true)
  })

  it.each(['latest', 'scroll', 'layout'] as const)('keeps %s intent authoritative when cancelled recovery receives a late page and resize', async (intent) => {
    const pending = deferred<boolean>()
    const readingPositions: ChatReadingPositions = new Map([['conversation-1:branch-1', {
      messageId: 'old-target',
      messageOffsetTop: 0,
      metrics: { clientHeight: 400, scrollHeight: 2000, scrollTop: 100 },
    }]])
    const fixture = createViewport(() => pending.promise, { readingPositions, listMounted: false })
    fixture.options.list.value = fixture.original.handle
    await nextTick()
    await nextTick()
    expect(fixture.viewport.isRestoringPosition.value).toBe(true)
    expect(fixture.original.metrics.scrollTop).toBe(600)

    if (intent === 'latest') {
      await fixture.viewport.returnToLatest()
    }
    else {
      if (intent === 'scroll')
        fixture.viewport.handleReaderScrollIntent()
      else fixture.viewport.handleReaderLayoutIntent()
      fixture.original.metrics.scrollTop = 450
      fixture.viewport.handleScroll(fixture.original.metrics, { userInitiated: true })
    }
    expect(fixture.viewport.isRestoringPosition.value).toBe(false)
    const acceptedTop = fixture.original.metrics.scrollTop
    fixture.original.anchorKeys.add('old-target')
    await prependHistory(fixture)
    pending.resolve(true)
    await nextTick()
    await nextTick()
    fixture.viewport.handleContentResize(fixture.original.metrics)

    expect(fixture.original.metrics.scrollTop).toBe(acceptedTop)
    expect(fixture.original.revealed).toEqual([])
    expect(fixture.original.highlights).toEqual([])
    expect(fixture.viewport.showReturnToLatest.value).toBe(intent !== 'latest')
    expect(fixture.viewport.isRestoringPosition.value).toBe(false)
  })

  it('keeps the latest position when the saved anchor is no longer available', async () => {
    const readingPositions: ChatReadingPositions = new Map([['conversation-1:branch-1', {
      messageId: 'removed',
      messageOffsetTop: 0,
      metrics: { clientHeight: 400, scrollHeight: 2000, scrollTop: 100 },
    }]])
    const fixture = createViewport(async () => false, { readingPositions, listMounted: false })
    fixture.options.list.value = fixture.original.handle
    for (let tick = 0; tick < 6; tick += 1)
      await nextTick()
    expect(fixture.original.metrics.scrollTop).toBe(600)
    expect(fixture.viewport.isRestoringPosition.value).toBe(false)
    expect(fixture.viewport.showReturnToLatest.value).toBe(false)
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

  it('shares one pending history request without writing scroll position for prepend or resize', async () => {
    const pending = deferred<boolean>()
    let requests = 0
    const fixture = createViewport(() => {
      requests += 1
      return pending.promise
    })
    fixture.viewport.handleScroll(fixture.original.metrics)
    fixture.original.metrics.scrollTop = 5
    fixture.viewport.handleScroll(fixture.original.metrics)
    await prependHistory(fixture)
    pending.resolve(true)
    await nextTick()

    expect(requests).toBe(1)
    expect(fixture.original.metrics.scrollTop).toBe(5)
    fixture.original.geometry.anchorTop += 80
    fixture.original.metrics.scrollHeight += 80
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(5)
    fixture.original.metrics.scrollHeight = 1_500
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(5)
    expect(requests).toBe(1)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)
  })

  it('restores a recent task reading position on a remounted transcript', async () => {
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

  it('releases position recovery when a pending notification target is cleared', async () => {
    const pending = deferred<boolean>()
    const fixture = createViewport(() => pending.promise, { revealMessageId: 'old-target' })
    expect(fixture.viewport.isRestoringPosition.value).toBe(true)
    fixture.options.revealMessageId.value = null
    await nextTick()
    await nextTick()
    expect(fixture.viewport.isRestoringPosition.value).toBe(false)
    pending.resolve(true)
    await nextTick()
    expect(fixture.original.revealed).toEqual([])
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

  it.each<Invalidation>(['conversation', 'branch', 'list', 'dispose'])('does not write position when pagination settles after %s invalidation', async (reason) => {
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

  it.each<Invalidation>(['conversation', 'branch', 'list', 'dispose', 'reader-layout'])('discards old outline paging, highlighting and scrolling after %s invalidation', async (reason) => {
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

  it('keeps explicit return-to-latest ownership without replaying late pagination or resize writes', async () => {
    const pending = deferred<boolean>()
    const fixture = createViewport(() => pending.promise)
    fixture.viewport.handleScroll(fixture.original.metrics)
    await fixture.viewport.returnToLatest()
    expect(fixture.original.metrics.scrollTop).toBe(600)
    fixture.original.metrics.scrollHeight = 1_400
    fixture.viewport.handleContentResize(fixture.original.metrics)
    pending.resolve(true)
    await nextTick()
    await nextTick()

    expect(fixture.original.metrics.scrollTop).toBe(600)
    expect(fixture.original.revealed).toEqual([])
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

  it.each([false, true])('restores the same content coordinate on list replacement (intermediate unmount: %s)', async (unmount) => {
    const fixture = createViewport(async () => false)
    fixture.original.metrics.scrollTop = 150
    fixture.viewport.handleScroll(fixture.original.metrics, { userInitiated: true })
    const anchor = fixture.original.handle.captureScrollAnchor()!
    if (unmount) {
      fixture.options.list.value = null
      await nextTick()
    }
    const replacement = createList()
    replacement.geometry.anchorTop = 400
    replacement.metrics.scrollHeight = 1400
    replacement.metrics.scrollTop = 250
    fixture.options.list.value = replacement.handle
    await nextTick()
    fixture.viewport.handleContentResize(replacement.metrics)

    expect(replacement.metrics.scrollTop).toBe(530)
    expect(replacement.handle.captureScrollAnchor()?.messageOffsetTop).toBe(anchor.messageOffsetTop)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)
  })

  it('keeps reader ownership when restoring initially reports a clamped bottom position', async () => {
    const positions: ChatReadingPositions = new Map([['conversation-1:branch-1', {
      messageId: 'visible',
      messageOffsetTop: -700,
      metrics: { clientHeight: 400, scrollHeight: 2000, scrollTop: 720 },
    }]])
    const fixture = createViewport(async () => false, { readingPositions: positions, listMounted: false })
    fixture.original.handle.restoreScrollAnchor = () => ({ clientHeight: 400, scrollHeight: 1000, scrollTop: 600 })
    fixture.options.list.value = fixture.original.handle
    await nextTick()
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)
    expect(fixture.viewport.isPositioning.value).toBe(false)
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

  it('releases a failed history request so reader movement can retry without a prepend position write', async () => {
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
    expect(fixture.original.metrics.scrollTop).toBe(19)
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(19)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)
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
    expect(fixture.original.metrics.scrollTop).toBe(20)
    expect(requests).toBe(2)
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(20)
  })

  it('clears previous reading states and writes the tail only for the explicit reset intent', async () => {
    const readingPositions: ChatReadingPositions = new Map()
    const fixture = createViewport(async () => false, { readingPositions })
    fixture.options.hasOlderMessages.value = false
    fixture.original.metrics.scrollTop = 200
    fixture.viewport.handleScroll(fixture.original.metrics)
    expect(fixture.viewport.showReturnToLatest.value).toBe(true)

    fixture.viewport.resetToTail()
    expect(fixture.viewport.showReturnToLatest.value).toBe(false)
    expect(fixture.original.metrics.scrollTop).toBe(200)
    await nextTick()
    expect(fixture.original.metrics.scrollTop).toBe(600)
    expect(readingPositions.get('conversation-1:branch-1')).toBeNull()

    fixture.original.metrics.scrollHeight = 1_400
    fixture.viewport.handleContentResize(fixture.original.metrics)
    expect(fixture.original.metrics.scrollTop).toBe(600)
    expect(fixture.viewport.showReturnToLatest.value).toBe(false)

    fixture.viewport.resetToTail()
    await nextTick()
    expect(fixture.original.metrics.scrollTop).toBe(1_000)
  })
})
