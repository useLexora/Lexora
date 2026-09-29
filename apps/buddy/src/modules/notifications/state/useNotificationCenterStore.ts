import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalNotification, LocalNotificationList } from '@buddy-shared/notifications/notificationApi'
import type { DesktopNotification } from '../contracts'
import type { DesktopUpdates } from '@/modules/updates/contracts'
import { computed, readonly, shallowRef } from 'vue'

export type NotificationFilter = 'all' | 'unseen'

export function filterNotifications(
  items: ReadonlyArray<DesktopNotification>,
  filter: NotificationFilter,
): ReadonlyArray<DesktopNotification> {
  return filter === 'unseen'
    ? items.filter(item => item.attention === 'unseen')
    : items
}

export function useNotificationCenterStore(api: {
  notifications: LocalChatApi['notifications']
}, updates: Pick<DesktopUpdates, 'state' | 'markSeen'>) {
  const localItems = shallowRef<ReadonlyArray<LocalNotification>>([])
  const items = computed<readonly DesktopNotification[]>(() => {
    const update = updates.state.value?.notification
    return [...(update ? [update] : []), ...localItems.value]
      .sort(compareNotifications)
  })
  const unseenCount = computed(() => items.value.filter(item => item.attention === 'unseen').length)
  const isLoading = shallowRef(false)
  const error = shallowRef<unknown>(null)
  let loadPromise: Promise<boolean> | null = null
  let refreshRequested = false
  let stopped = false
  let generation = 0
  let pendingMutations = 0
  let mutationQueue = Promise.resolve(true)
  const stopChanges = api.notifications.onChanged(() => {
    generation += 1
    refreshRequested = true
    if (!pendingMutations)
      void load()
  })

  const hasNotifications = computed(() => items.value.length > 0)

  function apply(value: LocalNotificationList) {
    localItems.value = value.items
  }

  function load(): Promise<boolean> {
    if (stopped)
      return Promise.resolve(false)
    if (pendingMutations) {
      refreshRequested = true
      return Promise.resolve(false)
    }
    if (loadPromise) {
      refreshRequested = true
      return loadPromise
    }
    refreshRequested = false
    isLoading.value = true
    error.value = null
    const current = generation
    loadPromise = api.notifications.list()
      .then((value) => {
        if (stopped)
          return false
        if (current !== generation || pendingMutations > 0) {
          refreshRequested = true
          return false
        }
        apply(value)
        return true
      })
      .catch((loadError) => {
        if (!stopped && current === generation)
          error.value = loadError
        return false
      })
      .finally(() => {
        if (!stopped)
          isLoading.value = false
        loadPromise = null
        if (refreshRequested) {
          refreshRequested = false
          void load()
        }
      })
    return loadPromise
  }

  function mutate(operation: () => Promise<LocalNotificationList>): Promise<boolean> {
    if (stopped)
      return Promise.resolve(false)
    generation += 1
    pendingMutations += 1
    const mutation = mutationQueue.then(async () => {
      if (stopped)
        return false
      error.value = null
      const current = generation
      try {
        const value = await operation()
        if (stopped)
          return false
        if (current === generation)
          apply(value)
        else
          refreshRequested = true
        return true
      }
      catch (markError) {
        refreshRequested = true
        if (!stopped)
          error.value = markError
        return false
      }
      finally {
        generation += 1
        pendingMutations -= 1
        if (!pendingMutations && refreshRequested)
          void load()
      }
    })
    mutationQueue = mutation
    return mutation
  }

  async function markSeen(notification: DesktopNotification): Promise<boolean> {
    if (stopped)
      return false
    if (notification.kind !== 'app.update-available')
      return mutate(() => api.notifications.markSeen(notification.id, notification.revision))
    try {
      await updates.markSeen(notification.revision)
      return true
    }
    catch (markError) {
      if (!stopped)
        error.value = markError
      return false
    }
  }

  async function markAllSeen() {
    const update = updates.state.value?.notification
    const results = await Promise.all([
      mutate(() => api.notifications.markAllSeen()),
      update ? markSeen(update) : true,
    ])
    return results.every(Boolean)
  }

  function dispose(): void {
    if (stopped)
      return
    stopped = true
    generation += 1
    refreshRequested = false
    stopChanges()
  }

  return {
    error: readonly(error),
    dispose,
    hasNotifications: readonly(hasNotifications),
    isLoading: readonly(isLoading),
    items: readonly(items),
    load,
    markAllSeen,
    markSeen,
    unseenCount: readonly(unseenCount),
  }
}

export type NotificationCenterStore = ReturnType<typeof useNotificationCenterStore>

function compareNotifications(left: DesktopNotification, right: DesktopNotification): number {
  if (left.attention !== right.attention)
    return left.attention === 'unseen' ? -1 : 1
  const leftActive = left.kind === 'app.update-available' || left.lifecycle === 'active'
  const rightActive = right.kind === 'app.update-available' || right.lifecycle === 'active'
  if (leftActive !== rightActive)
    return leftActive ? -1 : 1
  return right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id)
}
