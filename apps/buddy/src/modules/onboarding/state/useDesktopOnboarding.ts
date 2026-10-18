import type { LexoraConfigPatch } from '@buddy-electron/shared/desktopApi'
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { BuddyCatalog, LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import type { DesktopNavigationLayout } from '@buddy-shared/desktopNavigationLayout'
import type { Ref } from 'vue'
import type { BuddyI18nKey } from '@/i18n/buddyI18n'
import type { ModelProvidersStore } from '@/modules/models'
import type { ApplicationSettings } from '@/modules/settings/contracts'
import { BUDDY_AVATAR_MAX_BYTES } from '@buddy-shared/buddies/buddyApi'
import { parseLocalChatPublicError } from '@buddy-shared/runtime/localChatError'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { readBuddyAvatar } from '@/modules/buddies'

export interface OnboardingPreferences {
  navigationLayout: DesktopNavigationLayout
  updateNotificationsEnabled: boolean
  autoDownloadUpdates: boolean
  petEnabled: boolean
}

export function useDesktopOnboarding(options: {
  settings: ApplicationSettings
  providers: ModelProvidersStore
  buddies: { api: LocalChatApi['buddies'], catalog: Readonly<Ref<BuddyCatalog | null>>, refresh: () => Promise<void> }
  onComplete: () => Promise<unknown>
}) {
  const { settings, providers, buddies } = options
  const replaying = shallowRef(false)
  const pending = computed(() => replaying.value || settings.config.value?.desktop.onboardingCompleted === false)
  const step = shallowRef(0)
  const original = shallowRef<LocalBuddy | null>(null)
  const name = shallowRef('Lexora')
  const avatar = shallowRef<string | null>('preset:actor-lexora')
  const customAvatar = shallowRef<string | null>(null)
  const busy = shallowRef(false)
  const reading = shallowRef(false)
  const error = shallowRef<BuddyI18nKey | null>(null)
  const preferences = shallowRef<OnboardingPreferences>({ navigationLayout: 'full', updateNotificationsEnabled: true, autoDownloadUpdates: true, petEnabled: true })
  const disabled = computed(() => busy.value || reading.value)
  const canContinue = computed(() => !disabled.value && !!original.value && !!name.value.trim() && error.value !== 'onboarding.buddyConflict')
  let initializedPreferences = false
  let disposed = false

  function applyBuddy(buddy: LocalBuddy) {
    original.value = buddy
    name.value = buddy.name
    avatar.value = buddy.avatar ?? 'preset:actor-lexora'
    customAvatar.value = buddy.avatar?.startsWith('data:') ? buddy.avatar : buddy.customAvatars.at(-1) ?? null
  }

  watch([pending, buddies.catalog], ([active, catalog]) => {
    if (!active || replaying.value || original.value || !catalog)
      return
    const buddy = catalog.buddies.find(buddy => buddy.id === catalog.defaultBuddyId)
    if (buddy)
      applyBuddy(buddy)
  }, { immediate: true })
  function applyPreferences() {
    const config = settings.config.value
    if (!config)
      return
    initializedPreferences = true
    preferences.value = { navigationLayout: config.desktop.navigationLayout, updateNotificationsEnabled: config.desktop.updateNotificationsEnabled, autoDownloadUpdates: config.desktop.autoDownloadUpdates, petEnabled: config.pet.enabled }
  }
  watch(settings.config, () => {
    if (!initializedPreferences)
      applyPreferences()
  }, { immediate: true })

  async function open() {
    if (pending.value || disabled.value)
      return
    step.value = 0
    original.value = null
    error.value = null
    customAvatar.value = null
    applyPreferences()
    replaying.value = true
    await reloadBuddy()
  }

  function close() {
    if (replaying.value && !disabled.value)
      replaying.value = false
  }

  async function reloadBuddy() {
    if (disabled.value)
      return
    busy.value = true
    try {
      const catalog = await buddies.api.list()
      const buddy = catalog.buddies.find(buddy => buddy.id === catalog.defaultBuddyId)
      if (!buddy)
        throw new Error('DEFAULT_BUDDY_UNAVAILABLE')
      applyBuddy(buddy)
      error.value = null
      await buddies.refresh()
    }
    catch { error.value = 'onboarding.saveFailed' }
    finally { busy.value = false }
  }

  async function uploadAvatar(file: File) {
    if (disabled.value)
      return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > BUDDY_AVATAR_MAX_BYTES) {
      error.value = 'onboarding.invalidImage'
      return
    }
    reading.value = true
    try {
      const image = await readBuddyAvatar(file)
      if (!disposed) {
        customAvatar.value = image
        avatar.value = image
        if (error.value !== 'onboarding.buddyConflict')
          error.value = null
      }
    }
    catch { error.value = 'onboarding.invalidImage' }
    finally { reading.value = false }
  }

  async function continueFromBuddy() {
    if (!canContinue.value || !original.value)
      return
    busy.value = true
    error.value = null
    try {
      const buddy = original.value
      const customAvatars = [...new Set([...buddy.customAvatars, ...(customAvatar.value ? [customAvatar.value] : [])])]
      if (name.value.trim() !== buddy.name || avatar.value !== (buddy.avatar ?? 'preset:actor-lexora') || JSON.stringify(customAvatars) !== JSON.stringify(buddy.customAvatars)) {
        original.value = await buddies.api.update({ buddyId: buddy.id, expectedRevision: buddy.revision, name: name.value.trim(), avatar: avatar.value, customAvatars })
        await buddies.refresh()
      }
      step.value = 1
    }
    catch (reason) {
      error.value = reason instanceof Error && parseLocalChatPublicError(reason.message)?.code === 'BUDDY_CONFLICT' ? 'onboarding.buddyConflict' : 'onboarding.saveFailed'
    }
    finally { busy.value = false }
  }

  async function updateAppearance(patch: LexoraConfigPatch) {
    if (disabled.value)
      return
    busy.value = true
    error.value = null
    try {
      if (!await settings.updateSettings(patch))
        error.value = 'onboarding.saveFailed'
    }
    finally { busy.value = false }
  }

  async function complete() {
    if (disabled.value)
      return
    busy.value = true
    error.value = null
    try {
      const { petEnabled, ...desktop } = preferences.value
      if (!await settings.updateSettings({ desktop: { ...desktop, onboardingCompleted: true }, pet: { enabled: petEnabled } })) {
        error.value = 'onboarding.saveFailed'
        return
      }
      if (replaying.value)
        replaying.value = false
      else
        await options.onComplete()
    }
    finally { busy.value = false }
  }

  onScopeDispose(() => disposed = true)
  return { pending, replaying, step, name, avatar, customAvatar, preferences, busy, reading, disabled, canContinue, error, buddyReady: computed(() => !!original.value), settings, providers, open, close, reloadBuddy, uploadAvatar, continueFromBuddy, updateAppearance, complete }
}

export type DesktopOnboarding = ReturnType<typeof useDesktopOnboarding>
