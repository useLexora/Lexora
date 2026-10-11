<script setup lang="ts">
import type { DesktopUserProfileConfig } from '@buddy-electron/shared/desktopApi'
import type { ResolvedUserProfile } from './userProfile'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Camera20Regular, Dismiss20Regular } from '@vicons/fluent'
import { NButton, NForm, NFormItem, NInput, NModal } from 'naive-ui'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import DesktopAccountAvatar from '@/app/shell/DesktopAccountAvatar.vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  customProfile?: DesktopUserProfileConfig | null
  language: BuddyLocale
  resolvedProfile: ResolvedUserProfile
  show: boolean
  updateProfile?: (patch: Partial<DesktopUserProfileConfig>) => Promise<boolean | void> | boolean | void
}>()

const emit = defineEmits<{
  'update:show': [show: boolean]
  'updateProfile': [patch: Partial<DesktopUserProfileConfig>]
}>()

const { t } = useBuddyI18n(() => props.language)

const userName = shallowRef('')
const avatar = shallowRef('')
const isSaving = shallowRef(false)
const errorMessage = shallowRef<string | null>(null)
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')

watch(() => props.show, (show) => {
  if (show) {
    userName.value = props.customProfile?.userName ?? ''
    avatar.value = props.customProfile?.avatar ?? ''
    errorMessage.value = null
  }
}, { immediate: true })

const previewAvatarUrl = computed(() => {
  if (avatar.value.trim())
    return avatar.value
  return props.resolvedProfile.systemAvatarUrl ?? (props.resolvedProfile.isCustomAvatar ? null : props.resolvedProfile.avatarUrl)
})

const hasCustomAvatar = computed(() => {
  return !!avatar.value.trim()
})

const hasChanges = computed(() => {
  const currentUserName = props.customProfile?.userName ?? ''
  const currentAvatar = props.customProfile?.avatar ?? ''
  return userName.value !== currentUserName || avatar.value !== currentAvatar
})

function triggerAvatarUpload() {
  fileInput.value?.click()
}

function onAvatarFileSelected(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file)
    return

  if (!file.type.startsWith('image/')) {
    errorMessage.value = props.language === 'en-US' ? 'Please select an image file.' : '请选择图片文件。'
    target.value = ''
    return
  }

  if (file.size > 2 * 1024 * 1024) {
    errorMessage.value = props.language === 'en-US' ? 'Image file must be under 2MB.' : '图片大小不能超过 2MB。'
    target.value = ''
    return
  }

  const reader = new FileReader()
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      avatar.value = reader.result
      errorMessage.value = null
    }
  }
  reader.onerror = () => {
    errorMessage.value = props.language === 'en-US' ? 'Failed to read image.' : '读取图片失败。'
  }
  reader.readAsDataURL(file)
  target.value = ''
}

function resetAvatar() {
  avatar.value = ''
}

async function handleSave() {
  isSaving.value = true
  errorMessage.value = null
  try {
    const payload: Partial<DesktopUserProfileConfig> = {
      avatar: avatar.value,
      userName: userName.value.trim(),
    }
    const saved = props.updateProfile
      ? await props.updateProfile(payload)
      : undefined
    if (saved === false)
      throw new Error(t('desktop.account.saveFailed'))

    emit('updateProfile', payload)
    emit('update:show', false)
  }
  catch (error) {
    errorMessage.value = error instanceof Error ? error.message : t('desktop.account.saveFailed')
  }
  finally {
    isSaving.value = false
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="desktop-account-dialog"
    :style="{ width: 'min(26rem, calc(100vw - 2rem))' }"
    :title="t('desktop.account.dialogTitle')"
    @update:show="emit('update:show', $event)"
  >
    <div v-if="errorMessage" class="desktop-account-dialog__error mb-3 py-2 px-3 rounded-micro text-[0.8rem]" role="alert">
      {{ errorMessage }}
    </div>

    <div class="flex items-center gap-5 py-1 px-0">
      <div class="flex flex-col items-center gap-[0.4rem] flex-none">
        <div
          class="desktop-account-dialog__avatar-wrapper relative inline-block cursor-pointer rounded-full overflow-hidden"
          :title="t('desktop.account.changeAvatar')"
          @click="triggerAvatarUpload"
        >
          <DesktopAccountAvatar
            size="large"
            :avatar-url="previewAvatarUrl"
            :name="userName.trim() || resolvedProfile.userName"
            :initials="resolvedProfile.initials"
          />
          <div class="desktop-account-dialog__avatar-overlay absolute inset-0 flex flex-col items-center justify-center gap-[2px] text-[10px] font-500 opacity-0">
            <DesktopIcon :component="Camera20Regular" />
            <span>{{ t('desktop.account.changeAvatar') }}</span>
          </div>
        </div>
        <input
          ref="fileInput"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          style="display: none"
          @change="onAvatarFileSelected"
        >
        <button
          v-if="hasCustomAvatar"
          type="button"
          class="desktop-account-dialog__reset-avatar inline-flex items-center gap-[3px] py-[2px] px-[6px] border-0 rounded-micro bg-transparent text-muted text-[0.72rem] cursor-pointer hover:text-strong hover:bg-hover"
          @click="resetAvatar"
        >
          <DesktopIcon :component="Dismiss20Regular" />
          <span>{{ t('desktop.account.resetAvatar') }}</span>
        </button>
      </div>

      <NForm class="desktop-account-dialog__form" :show-feedback="false" label-placement="top">
        <NFormItem :label="t('desktop.account.userName')">
          <NInput
            v-model:value="userName"
            :placeholder="resolvedProfile.systemDisplayName || resolvedProfile.systemUsername || t('desktop.account.userNamePlaceholder')"
            :maxlength="30"
            show-count
            clearable
          />
        </NFormItem>
      </NForm>
    </div>

    <template #footer>
      <div class="flex justify-end gap-3">
        <NButton @click="emit('update:show', false)">
          {{ t('common.cancel') }}
        </NButton>
        <NButton
          type="primary"
          :loading="isSaving"
          :disabled="!hasChanges"
          @click="handleSave"
        >
          {{ t('desktop.account.saveAction') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.desktop-account-dialog__avatar-overlay {
  background: rgba(0, 0, 0, 0.55);
  color: #ffffff;
  transition: opacity var(--buddy-motion-state-duration) ease;
}

.desktop-account-dialog__avatar-wrapper:hover .desktop-account-dialog__avatar-overlay {
  opacity: 1;
}

.desktop-account-dialog__reset-avatar {
  transition:
    color var(--buddy-motion-state-duration) ease,
    background-color var(--buddy-motion-state-duration) ease
}

.desktop-account-dialog__form {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.desktop-account-dialog__error {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}
</style>
