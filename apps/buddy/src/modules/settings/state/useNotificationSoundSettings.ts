import type { LexoraConfig, LexoraConfigPatch, LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { DeepReadonly } from 'vue'
import { DEFAULT_NOTIFICATION_SOUND_PREFERENCES, isBuiltinNotificationSound } from '@buddy-shared/notifications/notificationSound'
import { computed, onActivated, onDeactivated, onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { useSettingMutation } from './useSettingMutation'

type SoundApi = LexoraDesktopApi['notificationSounds']
type ImportResult = Awaited<ReturnType<SoundApi['import']>>
type ImportFailure = Extract<ImportResult, { status: 'failed' }>['reason']
export type NotificationSoundFailure = 'save' | 'preview' | 'remove' | `import-${ImportFailure}`

export function useNotificationSoundSettings(options: {
  settings: {
    config: DeepReadonly<LexoraConfig> | null
    updateSettings: (patch: LexoraConfigPatch) => Promise<boolean>
  }
  api: SoundApi
  disabled: () => boolean
  onFailure: (failure: NotificationSoundFailure) => void
}) {
  const preferences = computed(() => options.settings.config?.desktop.notificationSound ?? DEFAULT_NOTIFICATION_SOUND_PREFERENCES)
  const importing = shallowRef(false)
  const removingId = shallowRef<string | null>(null)
  const previewingId = shallowRef<string | null>(null)
  let active = true
  let lifetime = 0
  let previewRevision = 0
  let previewTimer: ReturnType<typeof setTimeout> | undefined
  const { pending, save } = useSettingMutation<'selected' | 'volume'>(patch => options.settings.updateSettings(patch))
  const busy = computed(() => importing.value || removingId.value !== null || pending.value.size > 0)
  const selectionDisabled = computed(() => options.disabled() || !options.settings.config?.desktop.notificationsEnabled || busy.value)
  const volumeDisabled = computed(() => selectionDisabled.value || preferences.value.selected === 'system')

  function isCurrent(revision: number) {
    return active && revision === previewRevision
  }

  function resetPreview() {
    clearTimeout(previewTimer)
    previewTimer = undefined
    previewingId.value = null
  }

  async function stopPreview() {
    const revision = ++previewRevision
    resetPreview()
    try {
      await options.api.stopPreview()
    }
    catch {
      if (isCurrent(revision))
        options.onFailure('preview')
    }
  }

  async function preview(id: string) {
    if (!active || id === 'system' || removingId.value === id)
      return
    if (previewingId.value === id) {
      await stopPreview()
      return
    }
    const revision = ++previewRevision
    resetPreview()
    previewingId.value = id
    try {
      await options.api.stopPreview()
      if (!isCurrent(revision))
        return
      const { durationMs } = await options.api.preview(id)
      if (!isCurrent(revision))
        return
      previewTimer = setTimeout(() => {
        if (isCurrent(revision))
          resetPreview()
      }, durationMs)
    }
    catch {
      if (isCurrent(revision)) {
        resetPreview()
        options.onFailure('preview')
      }
    }
  }

  async function savePreference(field: 'selected' | 'volume', patch: Partial<Pick<LexoraConfig['desktop']['notificationSound'], 'selected' | 'volume'>>) {
    const owner = lifetime
    let succeeded = false
    try {
      succeeded = await save(field, { desktop: { notificationSound: patch } })
    }
    catch {}
    if (!succeeded && active && owner === lifetime)
      options.onFailure('save')
  }

  async function select(id: string) {
    if (!active || selectionDisabled.value || preferences.value.selected === id)
      return
    await savePreference('selected', { selected: id })
  }

  async function setVolume(volume: number) {
    if (!active || volumeDisabled.value || preferences.value.volume === volume)
      return
    await savePreference('volume', { volume })
  }

  async function importSound() {
    if (!active || busy.value)
      return
    const owner = lifetime
    importing.value = true
    try {
      const result = await options.api.import()
      if (active && owner === lifetime && result.status === 'failed')
        options.onFailure(`import-${result.reason}`)
    }
    catch {
      if (active && owner === lifetime)
        options.onFailure('import-read')
    }
    finally {
      importing.value = false
    }
  }

  async function remove(id: string, confirmed = false) {
    if (!active || busy.value || (preferences.value.selected === id && !confirmed))
      return
    const owner = lifetime
    removingId.value = id
    try {
      if (previewingId.value === id)
        await stopPreview()
      if (!active || owner !== lifetime)
        return
      await options.api.remove(id)
    }
    catch {
      if (active && owner === lifetime)
        options.onFailure('remove')
    }
    finally {
      removingId.value = null
    }
  }

  watch(() => preferences.value.sounds, (sounds) => {
    const id = previewingId.value
    if (id && !isBuiltinNotificationSound(id) && !sounds.some(sound => sound.id === id))
      void stopPreview()
  })

  function deactivate() {
    if (!active)
      return
    active = false
    lifetime++
    void stopPreview()
  }
  onDeactivated(deactivate)
  onActivated(() => {
    active = true
  })
  onScopeDispose(deactivate)

  return {
    preferences,
    importing: readonly(importing),
    removingId: readonly(removingId),
    previewingId: readonly(previewingId),
    pending,
    busy,
    selectionDisabled,
    volumeDisabled,
    select,
    setVolume,
    importSound,
    remove,
    preview,
  }
}
