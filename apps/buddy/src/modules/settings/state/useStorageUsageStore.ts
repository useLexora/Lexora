import type { StorageApi, StorageUsage } from '@buddy-shared/storage/storageApi'
import { shallowReadonly, shallowRef } from 'vue'

export function useStorageUsageStore(api: Pick<StorageApi, 'usage'>) {
  const usage = shallowRef<StorageUsage | null>(null)
  const loading = shallowRef(false)
  const failed = shallowRef(false)
  let pending: Promise<void> | null = null

  function refresh({ background = false }: { background?: boolean } = {}): Promise<void> {
    if (!background || !usage.value)
      loading.value = true
    if (pending)
      return pending
    failed.value = false
    pending = (async () => {
      try {
        usage.value = await api.usage()
      }
      catch {
        failed.value = true
      }
      finally {
        loading.value = false
      }
    })().finally(() => {
      pending = null
    })
    return pending
  }

  return {
    usage: shallowReadonly(usage),
    loading: shallowReadonly(loading),
    failed: shallowReadonly(failed),
    ensureLoaded: () => usage.value ? Promise.resolve() : refresh(),
    refresh,
  }
}

export type StorageUsageStore = ReturnType<typeof useStorageUsageStore>
