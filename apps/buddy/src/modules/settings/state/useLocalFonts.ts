import { onScopeDispose, readonly, shallowRef } from 'vue'
import { listLocalFontFamilies } from '@/platform/desktop/localFonts'

export function useLocalFonts(onFailure: () => void) {
  const families = shallowRef<readonly string[]>([])
  const loading = shallowRef(false)
  let loaded = false
  let disposed = false

  onScopeDispose(() => disposed = true)

  async function load(show: boolean): Promise<void> {
    if (!show || loaded || loading.value)
      return
    loading.value = true
    try {
      const result = await listLocalFontFamilies()
      if (!disposed) {
        families.value = result
        loaded = true
      }
    }
    catch {
      if (!disposed)
        onFailure()
    }
    finally {
      loading.value = false
    }
  }

  return { families: readonly(families), loading: readonly(loading), load }
}
