import type { InjectionKey, ShallowRef } from 'vue'
import { computed, inject } from 'vue'

export const readerAvatarsKey: InjectionKey<ShallowRef<Record<string, string>>> = Symbol('reader-avatars')

export function useReaderAvatar(authorId: () => string | null) {
  const avatars = inject(readerAvatarsKey)
  return computed(() => avatars?.value[authorId() ?? ''])
}
