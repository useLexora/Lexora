import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import type { BuddySettings } from '@buddy-shared/buddies/buddySettings'
import type { Ref } from 'vue'
import { buddySettingsSchema, DEFAULT_BUDDY_SETTINGS } from '@buddy-shared/buddies/buddySettings'
import { computed, ref, shallowRef, watch } from 'vue'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import { useBuddiesContext } from '../buddiesContext'

export function useBuddySettings(buddy: Readonly<Ref<LocalBuddy | null>>) {
  const { api } = useBuddiesContext()
  const { language } = useDesktopUi()
  const original = shallowRef(buddy.value)
  const settings = ref<BuddySettings>(buddySettingsSchema.parse(buddy.value?.settings ?? DEFAULT_BUDDY_SETTINGS))
  const busy = shallowRef(false)
  const error = shallowRef('')
  const changed = computed(() => original.value !== null && JSON.stringify(settings.value) !== JSON.stringify(original.value.settings))
  function reset(profile = buddy.value) {
    if (!profile)
      return
    original.value = profile
    settings.value = buddySettingsSchema.parse(profile.settings)
    error.value = ''
  }
  watch(buddy, (profile) => {
    if (!busy.value && !changed.value)
      reset(profile)
    else if (!busy.value && profile?.id === original.value?.id && JSON.stringify(profile?.settings) === JSON.stringify(original.value?.settings))
      original.value = profile
  })
  async function save() {
    const target = original.value
    if (!target || busy.value || !changed.value || !buddySettingsSchema.safeParse(settings.value).success)
      return
    busy.value = true
    error.value = ''
    try {
      const saved = await api.update({ buddyId: target.id, expectedRevision: target.revision, settings: buddySettingsSchema.parse(settings.value) })
      reset(saved)
      return saved
    }
    catch (reason) { error.value = resolveLocalChatErrorMessage(reason, language.value) }
    finally { busy.value = false }
  }
  return { settings, busy, error, changed, save, reset }
}
