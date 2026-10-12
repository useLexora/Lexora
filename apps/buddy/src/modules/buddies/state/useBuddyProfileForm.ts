import type { BuddyCreate, LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import { BUDDY_AVATAR_MAX_BYTES } from '@buddy-shared/buddies/buddyApi'
import { parseLocalChatPublicError } from '@buddy-shared/runtime/localChatError'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { BUDDY_AVATAR_PRESETS, buddyAvatarPresets } from '../model/buddyAvatarPresets'
import { readBuddyAvatar } from './readBuddyAvatar'

export interface BuddyProfileFormOptions {
  buddy?: LocalBuddy
  initialKind?: LocalBuddy['kind']
  disabled: boolean
  save: (input: BuddyCreate, original?: LocalBuddy) => Promise<LocalBuddy>
  reload: () => Promise<LocalBuddy | undefined>
}

interface AvatarDraft {
  selected: string | null
  custom: string | null
}

export function useBuddyProfileForm(options: BuddyProfileFormOptions, onSaved: (buddy: LocalBuddy) => void) {
  const original = shallowRef(options.buddy)
  const kind = shallowRef<LocalBuddy['kind']>(options.buddy?.kind ?? options.initialKind ?? 'actor')
  const name = shallowRef(options.buddy?.name ?? '')
  const description = shallowRef(options.buddy?.description ?? '')
  const avatars = shallowRef(initialAvatars(options.buddy))
  const busy = shallowRef(false)
  const reading = shallowRef(false)
  const error = shallowRef<'conflict' | 'saveFailed' | 'invalidImage' | null>(null)
  const avatar = computed(() => avatars.value[kind.value].selected)
  const customAvatar = computed(() => avatars.value[kind.value].custom)
  const changed = computed(() => kind.value !== (original.value?.kind ?? options.initialKind ?? 'actor') || name.value.trim() !== (original.value?.name ?? '') || avatar.value !== (original.value?.avatar ?? null) || description.value.trim() !== (original.value?.description ?? ''))
  const disabled = computed(() => options.disabled || busy.value || reading.value)
  const canSave = computed(() => !disabled.value && changed.value && !!name.value.trim() && error.value !== 'conflict')
  let generation = 0
  let disposed = false

  function initialAvatars(profile?: LocalBuddy): Record<LocalBuddy['kind'], AvatarDraft> {
    const drafts: Record<LocalBuddy['kind'], AvatarDraft> = {
      actor: { selected: buddyAvatarPresets('actor')[0]?.src ?? null, custom: null },
      npc: { selected: buddyAvatarPresets('npc')[0]?.src ?? null, custom: null },
    }
    if (profile)
      drafts[profile.kind] = { selected: profile.avatar, custom: profile.avatar }
    return drafts
  }

  function reset(profile = options.buddy) {
    generation++
    original.value = profile
    kind.value = profile?.kind ?? options.initialKind ?? 'actor'
    name.value = profile?.name ?? ''
    description.value = profile?.description ?? ''
    avatars.value = initialAvatars(profile)
    error.value = null
    reading.value = false
  }

  function selectAvatar(source: string | null) {
    if (disabled.value)
      return
    avatars.value = { ...avatars.value, [kind.value]: { ...avatars.value[kind.value], selected: source } }
    if (error.value === 'invalidImage')
      error.value = null
  }

  async function uploadAvatar(file: File) {
    if (disabled.value)
      return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > BUDDY_AVATAR_MAX_BYTES) {
      if (error.value !== 'conflict')
        error.value = 'invalidImage'
      return
    }
    const current = ++generation
    const targetKind = kind.value
    if (error.value !== 'conflict')
      error.value = null
    reading.value = true
    try {
      const source = await readBuddyAvatar(file)
      if (current === generation)
        avatars.value = { ...avatars.value, [targetKind]: { selected: source, custom: source } }
    }
    catch {
      if (current === generation && error.value !== 'conflict')
        error.value = 'invalidImage'
    }
    finally {
      if (current === generation)
        reading.value = false
    }
  }

  async function reload() {
    if (disabled.value)
      return
    busy.value = true
    try {
      const profile = await options.reload()
      if (!disposed && profile)
        reset(profile)
    }
    catch {
      if (!disposed)
        error.value = 'saveFailed'
    }
    finally {
      if (!disposed)
        busy.value = false
    }
  }

  async function save() {
    if (!canSave.value)
      return
    busy.value = true
    error.value = null
    try {
      const preset = BUDDY_AVATAR_PRESETS.find(preset => preset.src === avatar.value)
      const savedAvatar = preset ? await readBuddyAvatar(preset.src) : avatar.value
      if (disposed)
        return
      const saved = await options.save({ ...(original.value ? {} : { kind: kind.value }), name: name.value.trim(), avatar: savedAvatar, description: description.value.trim() }, original.value)
      if (!disposed) {
        reset(saved)
        onSaved(saved)
      }
    }
    catch (reason) {
      if (!disposed)
        error.value = reason instanceof Error && parseLocalChatPublicError(reason.message)?.code === 'BUDDY_CONFLICT' ? 'conflict' : 'saveFailed'
    }
    finally {
      if (!disposed)
        busy.value = false
    }
  }

  watch(() => options.buddy, (profile) => {
    if (!changed.value && !busy.value && !reading.value)
      reset(profile)
  })
  onScopeDispose(() => {
    disposed = true
    generation++
  })

  return { kind, name, description, avatar, customAvatar, busy, reading, error, changed, disabled, canSave, reset, selectAvatar, uploadAvatar, reload, save }
}
