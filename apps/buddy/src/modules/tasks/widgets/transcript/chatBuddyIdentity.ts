import type { LocalRun } from '@buddy-shared/runs/runApi'
import type { InjectionKey, Ref } from 'vue'
import { BUILTIN_BUDDY_ID } from '@buddy-shared/buddies/buddyApi'
import { computed, inject, provide } from 'vue'

const key: InjectionKey<Readonly<Ref<ReadonlyMap<string, string>>>> = Symbol('chatBuddyIdentity')

export function provideChatBuddyIdentity(runs: () => readonly Pick<LocalRun, 'id' | 'buddyId'>[]) {
  provide(key, computed(() => new Map(runs().map(run => [run.id, run.buddyId]))))
}

export function useChatBuddyId(runId: () => string | null | undefined) {
  const runs = inject(key, null)
  return computed(() => runs?.value.get(runId() ?? '') ?? BUILTIN_BUDDY_ID)
}
