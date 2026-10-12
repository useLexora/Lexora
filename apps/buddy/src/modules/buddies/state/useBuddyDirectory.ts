import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { BuddyCatalog, LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import type { Ref } from 'vue'
import { onScopeDispose, shallowReactive, watch } from 'vue'

export function useBuddyDirectory(api: LocalChatApi['buddies'], catalog: Readonly<Ref<BuddyCatalog | null>>, ready: Readonly<Ref<boolean>>) {
  const profiles = shallowReactive(new Map<string, LocalBuddy>())
  const pending = new Map<string, Promise<void>>()
  let disposed = false
  function accept(profile: LocalBuddy) {
    if (!disposed && profile.revision >= (profiles.get(profile.id)?.revision ?? 0))
      profiles.set(profile.id, profile)
  }
  async function load(id: string, force = false): Promise<void> {
    if (disposed || !ready.value || (!force && profiles.has(id)))
      return
    const running = pending.get(id)
    if (running) {
      await running
      if (force)
        return load(id, true)
      return
    }
    const operation = api.get(id).then(accept).catch(() => {}).finally(() => pending.delete(id))
    pending.set(id, operation)
    await operation
  }
  watch(catalog, value => value?.buddies.forEach(accept), { immediate: true })
  onScopeDispose(api.onChanged(({ buddyId }) => {
    if (profiles.has(buddyId))
      void load(buddyId, true)
  }))
  onScopeDispose(() => disposed = true)
  return { profiles, load }
}
