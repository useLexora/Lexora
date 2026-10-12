import type { MaybeRefOrGetter } from 'vue'
import { computed, toValue, watch } from 'vue'
import { useBuddiesContext } from '../buddiesContext'

export function useBuddyIdentity(id: MaybeRefOrGetter<string>) {
  const { profiles, load, ready } = useBuddiesContext()
  watch(() => [toValue(id), ready.value] as const, ([value, available]) => {
    if (available)
      void load(value)
  }, { immediate: true })
  return computed(() => profiles.get(toValue(id)) ?? null)
}
