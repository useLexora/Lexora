import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { Ref } from 'vue'
import { createInjectionState } from '@vueuse/core'
import { useBuddyDirectory } from './state/useBuddyDirectory'
import { useBuddyList } from './state/useBuddyList'

const [useProvideBuddiesContext, injectBuddiesContext] = createInjectionState(
  (context: { api: LocalChatApi['buddies'], ready: Readonly<Ref<boolean>> }) => {
    const list = useBuddyList(context.api, context.ready)
    return { ...context, ...list, ...useBuddyDirectory(context.api, list.catalog, context.ready) }
  },
)

export { useProvideBuddiesContext }

export function useBuddiesContext() {
  const context = injectBuddiesContext()
  if (!context)
    throw new Error('Buddies context is unavailable')
  return context
}
