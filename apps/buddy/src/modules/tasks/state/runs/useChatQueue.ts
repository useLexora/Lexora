import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalChatQueueItem, LocalChatQueueSteerResult } from '@buddy-shared/conversation/chatQueueApi'
import type { ChatSession } from '../conversations/useChatSession'
import type { RuntimeSupervisorStore } from '@/platform/runtime/useRuntimeSupervisorStore'
import { useIntervalFn } from '@vueuse/core'
import { onScopeDispose, readonly, shallowRef, watch } from 'vue'

export function useChatQueue(options: {
  api: Pick<LocalChatApi['chat'], 'listQueue' | 'cancelQueued' | 'steerQueued'>
  session: Pick<ChatSession, 'activeConversationId' | 'activeBranchId'>
  runtime: Pick<RuntimeSupervisorStore, 'runtimeState'>
  refreshConversation: () => Promise<void>
  onError: (error: unknown) => void
  onUnavailable: (reason: Exclude<LocalChatQueueSteerResult, 'accepted'> | 'cancel') => void
}) {
  const queuedMessages = shallowRef<readonly LocalChatQueueItem[]>([])
  const pendingQueueActions = shallowRef<ReadonlySet<string>>(new Set())
  const unavailableActions = new Map<string, string>()
  let generation = 0
  let disposed = false
  let refreshing = false
  const scope = () => {
    const conversationId = options.session.activeConversationId.value
    const branchId = options.session.activeBranchId.value
    return conversationId && branchId && options.runtime.runtimeState.value.status === 'ready' ? { conversationId, branchId } : null
  }
  async function refreshQueue() {
    const target = scope()
    if (!target || disposed)
      return
    const version = ++generation
    const items = await options.api.listQueue(target)
    if (disposed || version !== generation)
      return
    const removed = queuedMessages.value.some(item => !items.some(next => next.id === item.id))
    queuedMessages.value = items
    for (const id of unavailableActions.keys()) {
      if (!items.some(item => item.id === id))
        unavailableActions.delete(id)
    }
    if (removed)
      await options.refreshConversation()
  }
  async function poll() {
    if (refreshing)
      return
    refreshing = true
    try {
      await refreshQueue()
    }
    catch {}
    finally {
      refreshing = false
    }
  }
  useIntervalFn(poll, 1000)
  watch([options.session.activeConversationId, options.session.activeBranchId, () => options.runtime.runtimeState.value.status], () => {
    generation++
    queuedMessages.value = []
    unavailableActions.clear()
    void poll()
  }, { immediate: true })
  onScopeDispose(() => {
    disposed = true
    generation++
  })

  async function act(id: string, action: 'cancelQueued' | 'steerQueued') {
    const target = scope()
    if (!target || pendingQueueActions.value.has(id))
      return
    pendingQueueActions.value = new Set([...pendingQueueActions.value, id])
    try {
      const result = action === 'cancelQueued'
        ? await options.api.cancelQueued({ ...target, id }) ? 'accepted' : 'cancel'
        : await options.api.steerQueued({ ...target, id })
      await refreshQueue()
      if (scope()?.conversationId !== target.conversationId || scope()?.branchId !== target.branchId || disposed)
        return
      if (result !== 'accepted' && queuedMessages.value.some(item => item.id === id) && unavailableActions.get(id) !== result) {
        unavailableActions.set(id, result)
        options.onUnavailable(result)
      }
    }
    catch (error) {
      if (scope()?.conversationId === target.conversationId && scope()?.branchId === target.branchId)
        options.onError(error)
    }
    finally {
      pendingQueueActions.value = new Set([...pendingQueueActions.value].filter(value => value !== id))
    }
  }
  return {
    queuedMessages: readonly(queuedMessages),
    pendingQueueActions: readonly(pendingQueueActions),
    refreshQueue,
    cancelQueuedMessage: (id: string) => act(id, 'cancelQueued'),
    steerQueuedMessage: (id: string) => act(id, 'steerQueued'),
  }
}
