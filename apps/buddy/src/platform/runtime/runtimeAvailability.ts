import type { RuntimeMaintenance } from '@buddy-shared/lifecycle/runtimeLifecycle'
import type { InjectionKey, Ref } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'

export interface RuntimeAvailability {
  maintenance: Readonly<Ref<RuntimeMaintenance | null>>
  loading: Readonly<Ref<boolean>>
  failed: Readonly<Ref<boolean>>
  language: Readonly<Ref<BuddyLocale>>
  retry: () => Promise<void>
}

export const runtimeAvailabilityKey: InjectionKey<RuntimeAvailability> = Symbol('runtimeAvailability')
