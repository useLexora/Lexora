import type { DeviceNotification, DeviceNotificationList } from '@buddy-electron/shared/desktopNotifications'
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { DesktopNotification } from '../contracts'
import { compareNotifications } from '@buddy-electron/shared/desktopNotifications'
import { computed, readonly, shallowReactive, shallowRef } from 'vue'

interface NotificationSource {
  owns: (notification: DesktopNotification) => boolean
  items: () => readonly DesktopNotification[]
  markSeen: (revision: string) => Promise<void>
}

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
}) {
  const deviceItems = shallowRef<ReadonlyArray<DeviceNotification>>([])
  const sources = shallowReactive(new Set<NotificationSource>())
  function registerSource(source: NotificationSource) {
    sources.add(source)
    return () => sources.delete(source)
  }
  const items = computed<readonly DesktopNotification[]>(() => [
    ...deviceItems.value,
    ...Array.from(sources).flatMap(source => source.items()),
  ].sort(compareNotifications))
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

  function apply(value: DeviceNotificationList) {
    deviceItems.value = value.items
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

  function mutate(operation: () => Promise<DeviceNotificationList>): Promise<boolean> {
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
    const source = Array.from(sources).find(source => source.owns(notification))
    if (!source)
      return mutate(() => api.notifications.markSeen(notification.id, notification.revision))
    try {
      await source.markSeen(notification.revision)
      return true
    }
    catch (markError) {
      if (!stopped)
        error.value = markError
      return false
    }
  }

  async function markAllSeen() {
    const contributed = Array.from(sources).flatMap(source => source.items())
    const results = await Promise.all([
      mutate(() => api.notifications.markAllSeen()),
      ...contributed.filter(item => item.attention === 'unseen').map(markSeen),
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
    sources.clear()
  }

  return {
    error: readonly(error),
    dispose,
    hasNotifications: readonly(hasNotifications),
    isLoading: readonly(isLoading),
    items: readonly(items),
    load,
    registerSource,
    markAllSeen,
    markSeen,
    unseenCount: readonly(unseenCount),
  }
}

export type NotificationCenterStore = ReturnType<typeof useNotificationCenterStore>
