<script setup lang="ts">
import type { FormInstance } from 'element-plus'
import type { UserProfileSectionEmits, UserProfileSectionProps } from './typing'
import { useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import CopyStateIcon from '@/components/copy-state-icon/CopyStateIcon.vue'
import EntityAvatar from '@/components/entity-avatar'
import { useUserProfileSection } from '../../composables/useUserProfileSection'
import UserSettingsSectionHeader from '../section-header'

const props = defineProps<UserProfileSectionProps>()
const emit = defineEmits<UserProfileSectionEmits>()
const displayNameModel = defineModel<string>('displayName', { required: true })
const profileFormRef = useTemplateRef<FormInstance>('profileFormRef')
const fileInputRef = useTemplateRef<HTMLInputElement>('fileInputRef')
const { t } = useI18n({ useScope: 'global' })
const {
  copiedUserCode,
  displayNameRules,
  form,
  handleCopyUserCode,
  handleFileChange,
  handlePickAvatar,
  handleSaveDisplayName,
  sectionDescription,
} = useUserProfileSection({
  displayName: displayNameModel,
  fileInputRef,
  onSaveDisplayName: () => emit('saveDisplayName'),
  onUpload: file => emit('upload', file),
  props,
  profileFormRef,
})
</script>

<template>
  <ElCard shadow="never" class="user-profile-section">
    <UserSettingsSectionHeader
      :title="t('settings.user.profile.title')"
      :description="sectionDescription"
    >
      <template #aside>
        <div class="user-profile-section__account-code grid min-w-[11.25rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-[0.3125rem] pl-[0.625rem] max-[640px]:w-full max-[640px]:min-w-0">
          <span class="flex min-w-0 flex-col gap-[0.125rem]">
            <span class="text-[0.625rem] leading-none text-secondary">
              {{ t('settings.user.profile.accountCode') }}
            </span>
            <strong class="truncate font-mono text-xs leading-[1.1] text-main">{{ props.userCode }}</strong>
          </span>
          <ElTooltip :content="t('settings.user.profile.copyAccountCode')" placement="top">
            <ElButton
              text
              circle
              :type="copiedUserCode ? 'success' : 'primary'"
              class="user-profile-section__copy-button"
              :aria-label="copiedUserCode ? t('settings.user.profile.accountCodeCopied') : t('settings.user.profile.copyAccountCode')"
              @click="handleCopyUserCode"
            >
              <CopyStateIcon :copied="copiedUserCode" />
            </ElButton>
          </ElTooltip>
        </div>
      </template>
    </UserSettingsSectionHeader>

    <div class="user-profile-section__hero mb-5 flex flex-wrap items-center gap-4 rounded-[1rem] p-4">
      <EntityAvatar
        :name="form.displayName"
        :src="props.avatarUrl"
        :alt="t('settings.user.profile.avatarAlt', { name: form.displayName })"
        :size="72"
        shape="circle"
        kind="user"
        class="user-profile-section__avatar"
      />

      <div class="min-w-0">
        <ElButton
          :disabled="!props.canEditAvatar"
          :loading="props.isUploading"
          @click="handlePickAvatar"
        >
          {{ props.isUploading ? t('settings.user.profile.avatarUploading') : t('settings.user.profile.changeAvatar') }}
        </ElButton>
        <p class="mt-2 text-xs text-secondary">
          {{ props.canEditAvatar ? t('settings.user.profile.avatarUploadHint') : t('settings.user.profile.avatarLockedHint') }}
        </p>
      </div>

      <input
        ref="fileInputRef"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        class="hidden"
        @change="handleFileChange"
      >
    </div>

    <ElForm
      ref="profileFormRef"
      :model="form"
      :rules="props.canEditDisplayName ? displayNameRules : undefined"
      label-position="top"
      class="flex flex-col gap-1"
      @submit.prevent="handleSaveDisplayName"
    >
      <ElFormItem :label="t('settings.user.profile.displayName')" prop="displayName">
        <div class="user-profile-section__display-name-row flex w-full items-start gap-3">
          <ElInput
            v-model="form.displayName"
            class="min-w-0 flex-1"
            :readonly="!props.canEditDisplayName"
            maxlength="50"
            show-word-limit
          />
          <ElButton
            v-if="props.canEditDisplayName"
            type="primary"
            class="shrink-0"
            :loading="props.isSavingDisplayName"
            native-type="submit"
          >
            {{ t('settings.user.profile.save') }}
          </ElButton>
        </div>
      </ElFormItem>
    </ElForm>
  </ElCard>
</template>

<style scoped lang="scss">
.user-profile-section {
  border-color: color-mix(in srgb, var(--brand-border-base) 85%, transparent);

  &__account-code {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 78%, transparent);
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--brand-fill-lighter) 72%, transparent);
  }

  &__copy-button {
    transition:
      color 0.16s ease,
      background-color 0.16s ease,
      transform 0.16s ease;

    &.el-button--success {
      transform: translateY(-0.0625rem);
    }
  }

  &__hero {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 78%, transparent);
    border-radius: 1rem;
    background: color-mix(in srgb, var(--brand-fill-lighter) 72%, transparent);
  }

  &__avatar {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand-border-base) 70%, transparent);
  }
}
</style>
