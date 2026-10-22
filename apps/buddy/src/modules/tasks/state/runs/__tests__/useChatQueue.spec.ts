import type { LocalChatQueueItem, LocalChatQueueSteerResult } from '@buddy-shared/conversation/chatQueueApi'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useChatQueue } from '../useChatQueue'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

function fixture() {
  const scope = effectScope()
  scopes.push(scope)
  const activeConversationId = shallowRef('conversation')
  const activeBranchId = shallowRef('branch')
  let items: readonly LocalChatQueueItem[] = [{ id: 'input', buddyId: 'default', conversationId: 'conversation', branchId: 'branch', state: 'waiting', content: { userContent: createBuddyUserContent('Preserved input'), resourceSnapshots: [] }, attachments: [], createdAt: '2026-10-22T00:00:00.000Z' }]
  const api = {
    listQueue: async () => items,
    cancelQueued: async () => false,
    steerQueued: vi.fn<() => Promise<LocalChatQueueSteerResult>>(async () => 'unavailable'),
  }
  const onUnavailable = vi.fn()
  const onError = vi.fn()
  const queue = scope.run(() => useChatQueue({ api, session: { activeConversationId, activeBranchId }, runtime: { runtimeState: shallowRef({ status: 'ready' as const, lastError: null, pid: 1, restartAttempt: 0 }) }, refreshConversation: async () => {}, onUnavailable, onError }))!
  return { api, queue, onUnavailable, onError, activeConversationId, activeBranchId, clear: () => {
    items = []
  } }
}

describe('queued input feedback', () => {
  it('preserves rejected input, deduplicates each reason and clears the queue after an accepted retry', async () => {
    const f = fixture()
    await f.queue.refreshQueue()
    await f.queue.steerQueuedMessage('input')
    await f.queue.steerQueuedMessage('input')
    expect(f.onUnavailable.mock.calls).toEqual([['unavailable']])
    expect(f.queue.queuedMessages.value.map(item => item.id)).toEqual(['input'])
    f.api.steerQueued.mockResolvedValue('incompatible')
    await f.queue.steerQueuedMessage('input')
    expect(f.onUnavailable.mock.calls).toEqual([['unavailable'], ['incompatible']])
    f.api.steerQueued.mockResolvedValue('accepted')
    await f.queue.steerQueuedMessage('input')
    expect(f.onUnavailable.mock.calls).toEqual([['unavailable'], ['incompatible']])
    expect(f.onError).not.toHaveBeenCalled()
    f.clear()
    await f.queue.refreshQueue()
    expect(f.queue.queuedMessages.value).toEqual([])
    expect(f.queue.pendingQueueActions.value.size).toBe(0)
  })

  it('does not show an old conversation failure after switching tasks', async () => {
    const f = fixture()
    const result = Promise.withResolvers<LocalChatQueueSteerResult>()
    f.api.steerQueued.mockReturnValue(result.promise)
    const pending = f.queue.steerQueuedMessage('input')
    f.activeConversationId.value = 'other-conversation'
    f.activeBranchId.value = 'other-branch'
    result.resolve('unavailable')
    await pending
    expect(f.onUnavailable).not.toHaveBeenCalled()
    expect(f.queue.pendingQueueActions.value.size).toBe(0)
  })
})
