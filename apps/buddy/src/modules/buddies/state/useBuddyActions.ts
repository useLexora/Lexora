import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import type { Ref } from 'vue'
import { BUILTIN_BUDDY_ID } from '@buddy-shared/buddies/buddyApi'
import { computed, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import { useBuddiesContext } from '../buddiesContext'

export function useBuddyActions(buddy: Readonly<Ref<LocalBuddy | null>>) {
  const { api, catalog, refresh } = useBuddiesContext()
  const { language } = useDesktopUi()
  const router = useRouter()
  const busy = shallowRef(false)
  const error = shallowRef('')
  const confirmation = shallowRef<{ action: 'delete' | 'resetProfile', buddy: LocalBuddy } | null>(null)
  const isDefault = computed(() => buddy.value?.id === catalog.value?.defaultBuddyId)
  const isBuiltin = computed(() => buddy.value?.id === BUILTIN_BUDDY_ID)

  async function setDefault() {
    if (busy.value || !buddy.value || !catalog.value || buddy.value.kind !== 'actor' || !buddy.value.enabled)
      return
    busy.value = true
    error.value = ''
    try {
      await api.setDefault({ buddyId: buddy.value.id, expectedCatalogRevision: catalog.value.revision })
      await refresh()
    }
    catch (reason) {
      error.value = resolveLocalChatErrorMessage(reason, language.value)
      await refresh()
    }
    finally { busy.value = false }
  }

  async function setEnabled(enabled: boolean) {
    const target = buddy.value
    if (busy.value || !target || target.enabled === enabled || (isDefault.value && !enabled))
      return
    busy.value = true
    error.value = ''
    try {
      await api.update({ buddyId: target.id, expectedRevision: target.revision, enabled })
      await refresh()
    }
    catch (reason) {
      error.value = resolveLocalChatErrorMessage(reason, language.value)
      await refresh()
    }
    finally { busy.value = false }
  }

  function request(action: string) {
    if (buddy.value && (action === 'delete' || action === 'resetProfile')) {
      error.value = ''
      confirmation.value = { action, buddy: buddy.value }
    }
  }

  async function confirm() {
    const target = confirmation.value
    if (!target || busy.value)
      return
    busy.value = true
    error.value = ''
    try {
      await api[target.action]({ buddyId: target.buddy.id, expectedRevision: target.buddy.revision })
      confirmation.value = null
      await refresh()
      if (target.action === 'delete')
        await router.replace(desktopRouteLocations.buddies(catalog.value?.defaultBuddyId ?? BUILTIN_BUDDY_ID))
    }
    catch (reason) {
      error.value = resolveLocalChatErrorMessage(reason, language.value)
      confirmation.value = null
      await refresh()
    }
    finally { busy.value = false }
  }

  return { busy, error, isDefault, isBuiltin, confirmation, setDefault, setEnabled, request, confirm }
}
