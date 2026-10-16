<script setup lang="ts">
import type { FormInstance } from 'element-plus'
import { useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChangePassword } from '../../composables/useChangePassword'
import AuthEntryShell from '../../layouts/entry-shell'

const changePasswordFormRef = useTemplateRef<FormInstance>('changePasswordFormRef')
const { t } = useI18n({ useScope: 'global' })
const {
  form,
  formRules,
  handleSubmitChangePassword,
  isSubmitting,
  pageDescription,
  requiresPasswordChange,
} = useChangePassword({
  changePasswordFormRef,
})
</script>

<template>
  <AuthEntryShell
    :title="t('auth.changePassword.title')"
    :description="pageDescription"
  >
    <ElAlert
      v-if="requiresPasswordChange"
      type="warning"
      show-icon
      :closable="false"
      :title="t('auth.changePassword.forceAlert')"
      class="mb-4"
    />

    <ElForm
      ref="changePasswordFormRef"
      :model="form"
      :rules="formRules"
      label-position="top"
      class="w-full"
      @submit.prevent="handleSubmitChangePassword"
    >
      <ElFormItem :label="t('auth.changePassword.currentPassword')" prop="currentPassword">
        <ElInput v-model="form.currentPassword" type="password" show-password autocomplete="current-password" :placeholder="t('auth.changePassword.currentPasswordPlaceholder')" />
      </ElFormItem>
      <ElFormItem :label="t('auth.changePassword.newPassword')" prop="newPassword">
        <ElInput v-model="form.newPassword" type="password" show-password autocomplete="new-password" :placeholder="t('auth.changePassword.newPasswordPlaceholder')" />
      </ElFormItem>
      <ElFormItem :label="t('auth.changePassword.confirmNewPassword')" prop="confirmPassword">
        <ElInput v-model="form.confirmPassword" type="password" show-password autocomplete="new-password" :placeholder="t('auth.changePassword.confirmNewPasswordPlaceholder')" />
      </ElFormItem>
      <ElButton type="primary" native-type="submit" class="mt-3 w-full min-h-[2.875rem]" :loading="isSubmitting">
        {{ t('auth.changePassword.submit') }}
      </ElButton>
    </ElForm>
  </AuthEntryShell>
</template>
