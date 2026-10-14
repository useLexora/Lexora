import type { SnapshotCatalog } from '@buddy-shared/storage/snapshot'
import type { StorageApi, StorageProgress, StorageSummary } from '@buddy-shared/storage/storageApi'
import type { SyncApi } from '@buddy-shared/sync/syncApi'
import type { StorageUsageStore } from './useStorageUsageStore'
import { computed, shallowReadonly, shallowRef } from 'vue'

export function useStorageStore(api: Pick<StorageApi, 'summary' | 'snapshots' | 'onProgress'>, sync: Pick<SyncApi, 'onChanged'>, usage: StorageUsageStore) {
  const summary = shallowRef<StorageSummary | null>(null)
  const catalog = shallowRef<SnapshotCatalog>({ snapshots: [], unreadableIds: [] })
  const progress = shallowRef<StorageProgress | null>(null)
  const loading = shallowRef(false)
  const mutating = shallowRef(false)
  const busy = computed(() => mutating.value || progress.value !== null)
  let revision = 0
  let loaded = false
  let pending: Promise<void> | undefined
  let cloudRunning = false

  function refresh(): Promise<void> {
    const current = ++revision
    loading.value = true
    loaded = false
    pending = Promise.allSettled([api.summary(), api.snapshots()]).then(([nextSummary, nextCatalog]) => {
      if (current !== revision)
        return
      if (nextSummary.status === 'fulfilled')
        summary.value = nextSummary.value
      if (nextCatalog.status === 'fulfilled')
        catalog.value = nextCatalog.value
      if (nextSummary.status === 'rejected')
        throw nextSummary.reason
      if (nextCatalog.status === 'rejected')
        throw nextCatalog.reason
      loaded = true
    }).finally(() => {
      if (current === revision) {
        loading.value = false
        pending = undefined
      }
    })
    return pending
  }

  async function run<T>(action: () => Promise<T>): Promise<T> {
    if (busy.value)
      throw new Error('STORAGE_OPERATION_PENDING')
    mutating.value = true
    try {
      let result: T
      try {
        result = await action()
      }
      catch (error) {
        await refresh().catch(() => {})
        throw error
      }
      await refresh()
      return result
    }
    finally {
      mutating.value = false
      void usage.refresh({ background: true })
    }
  }

  const stopProgress = api.onProgress(next => progress.value = next)
  const stopSync = sync.onChanged((state) => {
    const running = state.schedules.some(item => item.status === 'running') || state.activity?.state === 'running'
    if (cloudRunning && !running) {
      void refresh().catch(() => {})
      void usage.refresh({ background: true })
    }
    cloudRunning = running
  })
  function dispose() {
    revision++
    stopProgress()
    stopSync()
  }

  return {
    summary: shallowReadonly(summary),
    catalog: shallowReadonly(catalog),
    progress: shallowReadonly(progress),
    loading: shallowReadonly(loading),
    busy,
    ensureLoaded: () => loaded ? Promise.resolve() : pending ?? refresh(),
    refresh,
    run,
    dispose,
  }
}

export type StorageStore = ReturnType<typeof useStorageStore>
