<script setup lang="ts">
import type { FormInstance } from 'element-plus'
import type { UserDeleteSectionEmits, UserDeleteSectionProps } from './typing'
import { useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUserDeleteSection } from '../../composables/useUserDeleteSection'
import UserSettingsSectionHeader from '../section-header'

const props = defineProps<UserDeleteSectionProps>()
const emit = defineEmits<UserDeleteSectionEmits>()
const deleteFormRef = useTemplateRef<FormInstance>('deleteFormRef')
const { t } = useI18n({ useScope: 'global' })
const {
  accountLabel,
  accountPlaceholder,
  form,
  handleConfirm,
  isDialogVisible,
  isSubmitDisabled,
  openDialog,
  closeDialog,
  resetForm,
  rules,
} = useUserDeleteSection({
  deleteFormRef,
  onDeleteAccount: payload => emit('deleteAccount', payload),
  props,
})
</script>

<template>
  <ElCard shadow="never" class="user-delete-section">
    <UserSettingsSectionHeader
      :title="t('settings.user.delete.title')"
      :description="t('settings.user.delete.description')"
    />

    <ElButton
      type="danger"
      :loading="props.isDeleting"
      @click="openDialog"
    >
      {{ props.isDeleting ? t('settings.user.delete.deleting') : t('settings.user.delete.title') }}
    </ElButton>

    <ElDialog
      v-model="isDialogVisible"
      :title="t('settings.user.delete.confirmDialogTitle')"
      width="32rem"
      destroy-on-close
      @closed="resetForm"
    >
      <div class="mb-4">
        <p class="m-0 text-sm leading-6 text-main">
          {{ t('settings.user.delete.dialogDescription', { accountLabel }) }}
        </p>
        <p class="mt-1.5 break-all text-sm leading-6 text-secondary">
          {{ accountLabel }}：{{ props.confirmationTarget }}
        </p>
      </div>

      <ElForm
        ref="deleteFormRef"
        :model="form"
        :rules="rules"
        label-position="top"
        class="flex flex-col gap-1"
        @submit.prevent="handleConfirm"
      >
        <ElFormItem :label="accountLabel" prop="accountConfirmation">
          <ElInput
            v-model="form.accountConfirmation"
            :autocomplete="props.confirmationMode === 'email' ? 'email' : 'off'"
            :placeholder="accountPlaceholder"
          />
        </ElFormItem>

        <ElFormItem :label="t('settings.user.delete.confirmPhrase')" prop="confirmationPhrase">
          <ElInput
            v-model="form.confirmationPhrase"
            :placeholder="t('settings.user.delete.confirmPhrasePlaceholder', { phrase: props.confirmationPhrase })"
          />
        </ElFormItem>
      </ElForm>

      <template #footer>
        <div class="flex justify-end gap-3">
          <ElButton @click="closeDialog">
            {{ t('settings.user.delete.cancel') }}
          </ElButton>
          <ElButton
            type="danger"
            :disabled="isSubmitDisabled"
            :loading="props.isDeleting"
            @click="handleConfirm"
          >
            {{ props.isDeleting ? t('settings.user.delete.deleting') : t('settings.user.delete.permanentDelete') }}
          </ElButton>
        </div>
      </template>
    </ElDialog>
  </ElCard>
</template>

<style scoped lang="scss">
.user-delete-section {
  border-color: color-mix(in srgb, var(--brand-error) 34%, var(--brand-border-base));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--brand-error) 3%, var(--brand-bg-surface)) 0%, var(--brand-bg-surface) 100%);
}
</style>
