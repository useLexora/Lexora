import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { BuddyCatalog } from '@buddy-shared/buddies/buddyApi'
import type { Ref } from 'vue'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'

export function useBuddyList(api: LocalChatApi['buddies'], ready: Readonly<Ref<boolean>>) {
  const catalog = shallowRef<BuddyCatalog | null>(null)
  const failed = shallowRef(false)
  let generation = 0

  async function refresh() {
    if (!ready.value)
      return
    const current = ++generation
    try {
      const result = await api.list()
      if (current !== generation)
        return
      if (!catalog.value || result.revision >= catalog.value.revision)
        catalog.value = result
      failed.value = false
    }
    catch {
      if (current === generation)
        failed.value = true
    }
  }

  onScopeDispose(api.onChanged(() => void refresh()))
  watch(ready, (value) => {
    if (value)
      void refresh()
    else
      generation++
  }, { immediate: true })
  onScopeDispose(() => generation++)
  return { catalog: computed(() => catalog.value), buddies: computed(() => catalog.value?.buddies ?? []), failed: computed(() => failed.value), refresh }
}
