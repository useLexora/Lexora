import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import type { Ref } from 'vue'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'

export function useBuddyProfile(api: LocalChatApi['buddies'], buddyId: string, ready: Readonly<Ref<boolean>>) {
  const buddy = shallowRef<LocalBuddy | null>(null)
  const failed = shallowRef(false)
  const loading = shallowRef(false)
  let generation = 0

  async function refresh() {
    if (!ready.value)
      return
    const current = ++generation
    loading.value = true
    try {
      const profile = await api.get(buddyId)
      if (current !== generation)
        return
      if (!buddy.value || profile.revision >= buddy.value.revision)
        buddy.value = profile
      failed.value = false
      return buddy.value
    }
    catch {
      if (current === generation)
        failed.value = true
    }
    finally {
      if (current === generation)
        loading.value = false
    }
  }

  onScopeDispose(api.onChanged((event) => {
    if (event.buddyId === buddyId)
      void refresh()
  }))
  watch(ready, (value) => {
    if (value)
      void refresh()
    else
      generation++
  }, { immediate: true })
  onScopeDispose(() => generation++)
  return { buddy: computed(() => buddy.value), failed: computed(() => failed.value), loading: computed(() => loading.value), refresh }
}
