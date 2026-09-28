<script setup lang="ts">
import type { DesktopAgentProfileConfig } from '@buddy-electron/shared/desktopApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ResolvedUserProfile } from '@/modules/settings/widgets/account/userProfile'
import { DESKTOP_PROFILE_AVATAR_MAX_BYTES } from '@buddy-electron/shared/desktopApi'
import { NButton, NInput, NSwitch, useMessage } from 'naive-ui'
import { computed, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopAccountAvatar from '@/modules/settings/widgets/account/DesktopAccountAvatar.vue'
import { BRAND_ASSET_URLS } from '@/shared/branding/brandAssets'

const props = defineProps<{
  language: BuddyLocale
  profile: DesktopAgentProfileConfig
  syncedProfile: ResolvedUserProfile
  updateProfile: (patch: Partial<DesktopAgentProfileConfig>) => Promise<boolean>
}>()

const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const syncLabelId = useId()
const nameLabelId = useId()
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const nameDraft = shallowRef('')
const avatarDraft = shallowRef('')
const errorMessage = shallowRef<string | null>(null)
const isSaving = shallowRef(false)
const isSyncing = shallowRef(false)

watch(
  () => props.profile,
  (profile) => {
    nameDraft.value = profile.name
    avatarDraft.value = profile.avatar
    errorMessage.value = null
  },
  { immediate: true },
)

const synced = computed(() => props.profile.syncWithUserProfile)
const previewAvatarUrl = computed(() => avatarDraft.value.trim() || BRAND_ASSET_URLS.chatAvatar)
const previewName = computed(() => (synced.value ? props.syncedProfile.userName : ''))
const hasChanges = computed(() => (
  !synced.value
  && (nameDraft.value.trim() !== props.profile.name || avatarDraft.value !== props.profile.avatar)
))

async function setSyncWithUserProfile(value: boolean) {
  if (isSyncing.value)
    return
  isSyncing.value = true
  errorMessage.value = null
  try {
    if (!await props.updateProfile({ syncWithUserProfile: value }))
      throw new Error(t('desktop.agent.saveFailed'))
  }
  catch (error) {
    errorMessage.value = error instanceof Error ? error.message : t('desktop.agent.saveFailed')
    message.error(errorMessage.value)
  }
  finally {
    isSyncing.value = false
  }
}

function triggerAvatarUpload() {
  fileInput.value?.click()
}

function onAvatarFileSelected(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file)
    return
  if (!file.type.startsWith('image/')) {
    errorMessage.value = t('desktop.agent.avatarInvalidType')
    return
  }
  if (file.size > DESKTOP_PROFILE_AVATAR_MAX_BYTES) {
    errorMessage.value = t('desktop.agent.avatarTooLarge')
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      avatarDraft.value = reader.result
      errorMessage.value = null
    }
  }
  reader.onerror = () => {
    errorMessage.value = t('desktop.agent.avatarReadFailed')
  }
  reader.readAsDataURL(file)
}

function resetAvatar() {
  avatarDraft.value = ''
  errorMessage.value = null
}

async function save() {
  if (isSaving.value || !hasChanges.value)
    return
  isSaving.value = true
  errorMessage.value = null
  try {
    const saved = await props.updateProfile({
      avatar: avatarDraft.value,
      name: nameDraft.value.trim(),
    })
    if (!saved)
      throw new Error(t('desktop.agent.saveFailed'))
  }
  catch (error) {
    errorMessage.value = error instanceof Error ? error.message : t('desktop.agent.saveFailed')
    message.error(errorMessage.value)
  }
  finally {
    isSaving.value = false
  }
}
</script>

<template>
  <section class="desktop-agent-settings">
    <h2 class="desktop-agent-settings__title">
      {{ t('desktop.agent.sectionTitle') }}
    </h2>
    <div class="desktop-agent-settings__group">
      <div class="desktop-agent-settings__row" data-testid="desktop-agent-identity-setting">
        <div class="desktop-agent-settings__avatar-col">
          <span class="desktop-agent-settings__avatar">
            <DesktopAccountAvatar
              v-if="synced"
              size="medium"
              :avatar-url="syncedProfile.avatarUrl"
              :background-color="syncedProfile.avatarColor"
              :initials="syncedProfile.initials"
              :name="syncedProfile.userName"
            />
            <img v-else :src="previewAvatarUrl" alt="" draggable="false">
          </span>
          <div v-if="!synced" class="desktop-agent-settings__avatar-actions">
            <NButton size="small" secondary :disabled="isSaving" @click="triggerAvatarUpload">
              {{ t('desktop.agent.changeAvatar') }}
            </NButton>
            <NButton size="small" quaternary :disabled="isSaving || !avatarDraft" @click="resetAvatar">
              {{ t('desktop.agent.resetAvatar') }}
            </NButton>
          </div>
          <input
            ref="fileInput"
            class="desktop-agent-settings__file"
            type="file"
            accept="image/*"
            @change="onAvatarFileSelected"
          >
        </div>

        <div class="desktop-agent-settings__copy">
          <template v-if="synced">
            <strong>{{ t('desktop.agent.syncedFromProfile') }}</strong>
            <small>{{ previewName || t('desktop.chat.agentName') }}</small>
          </template>
          <template v-else>
            <label :id="nameLabelId" class="desktop-agent-settings__label" for="desktop-agent-name">
              {{ t('desktop.agent.name') }}
            </label>
            <NInput
              id="desktop-agent-name"
              v-model:value="nameDraft"
              :aria-labelledby="nameLabelId"
              maxlength="30"
              :placeholder="t('desktop.agent.namePlaceholder')"
              :disabled="isSaving"
            />
            <small class="desktop-agent-settings__help">{{ t('desktop.agent.nameHelp') }}</small>
          </template>
          <p v-if="errorMessage" class="desktop-agent-settings__error" role="alert">
            {{ errorMessage }}
          </p>
        </div>

        <div class="desktop-agent-settings__actions">
          <div class="desktop-agent-settings__sync-toggle" data-testid="desktop-agent-sync-setting">
            <span :id="syncLabelId" class="desktop-agent-settings__sync-label">
              {{ t('desktop.agent.syncWithProfile') }}
            </span>
            <NSwitch
              size="small"
              :aria-labelledby="syncLabelId"
              :round="false"
              :value="synced"
              :loading="isSyncing"
              :disabled="isSyncing"
              @update:value="setSyncWithUserProfile"
            />
          </div>
          <NButton
            v-if="!synced"
            size="small"
            type="primary"
            :disabled="!hasChanges"
            :loading="isSaving"
            @click="save"
          >
            {{ t('desktop.agent.saveAction') }}
          </NButton>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.desktop-agent-settings {
  display: grid;
  gap: 0.8rem;
}

.desktop-agent-settings__title {
  margin: 0;
  font-size: 0.92rem;
}

.desktop-agent-settings__group {
  overflow: hidden;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 0.65rem;
  background: var(--buddy-surface-base);
}

.desktop-agent-settings__row {
  display: grid;
  min-height: 4rem;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 1.1rem;
  padding: 0.9rem;
}

.desktop-agent-settings__avatar-col {
  display: grid;
  justify-items: center;
  gap: 0.5rem;
}

.desktop-agent-settings__avatar {
  display: block;
  width: 3rem;
  height: 3rem;
  overflow: hidden;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 50%;
}

.desktop-agent-settings__avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.desktop-agent-settings__avatar-actions {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.desktop-agent-settings__file {
  display: none;
}

.desktop-agent-settings__copy {
  display: grid;
  min-width: 0;
  gap: 0.35rem;
}

.desktop-agent-settings__copy strong {
  color: var(--buddy-text-primary);
  font-size: 0.8rem;
  font-weight: 600;
}

.desktop-agent-settings__copy small {
  color: var(--buddy-text-secondary);
  font-size: 0.7rem;
  line-height: 1.5;
}

.desktop-agent-settings__label {
  color: var(--buddy-text-primary);
  font-size: 0.8rem;
  font-weight: 600;
}

.desktop-agent-settings__help {
  color: var(--buddy-text-secondary);
  font-size: 0.7rem;
  line-height: 1.5;
}

.desktop-agent-settings__error {
  margin: 0;
  color: var(--buddy-status-danger-text);
  font-size: 0.7rem;
}

.desktop-agent-settings__actions {
  display: flex;
  align-self: center;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.6rem;
}

.desktop-agent-settings__sync-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.desktop-agent-settings__sync-label {
  color: var(--buddy-text-secondary);
  font-size: 0.75rem;
  white-space: nowrap;
}

@container (max-width: 560px) {
  .desktop-agent-settings__row {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .desktop-agent-settings__actions {
    grid-column: 1 / -1;
    justify-content: flex-end;
  }
}
</style>
