import type { ExtensionApi } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionCatalogSnapshot } from '@buddy-shared/extensions/extensionCatalog'
import { onScopeDispose, shallowRef } from 'vue'

export function useExtensionCatalog(api: Pick<ExtensionApi, 'catalog'>) {
  const snapshot = shallowRef<ExtensionCatalogSnapshot | null>(null)
  const loading = shallowRef(false)
  const error = shallowRef(false)
  let disposed = false
  let revision = 0

  async function refresh(force = false) {
    const current = ++revision
    loading.value = true
    error.value = false
    try {
      const next = await api.catalog(force)
      if (!disposed && revision === current) {
        snapshot.value = next
        error.value = !!next.error
      }
    }
    catch {
      if (!disposed && revision === current)
        error.value = true
    }
    finally {
      if (!disposed && revision === current)
        loading.value = false
    }
  }

  void refresh()
  onScopeDispose(() => {
    disposed = true
    revision++
  })
  return { snapshot, loading, error, refresh }
}
