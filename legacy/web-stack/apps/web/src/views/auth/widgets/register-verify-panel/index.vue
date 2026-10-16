<script setup lang="ts">
import type { FormInstance } from 'element-plus'
import { useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRegisterVerify } from '../../composables/useRegisterVerify'
import AuthEntryShell from '../../layouts/entry-shell'

const registerFormRef = useTemplateRef<FormInstance>('registerFormRef')
const { t } = useI18n({ useScope: 'global' })
const {
  errorMessage,
  form,
  formRules,
  handleSubmitRegistration,
  isReady,
  isSubmitting,
  pageDescription,
  statusLabel,
} = useRegisterVerify({
  registerFormRef,
})
</script>

<template>
  <AuthEntryShell
    :title="statusLabel"
    :description="pageDescription"
  >
    <ElAlert
      v-if="errorMessage"
      :title="errorMessage"
      type="error"
      show-icon
      :closable="false"
      class="password-register-verify-view__alert mb-4"
    />

    <div v-else class="password-register-verify-view__body w-full">
      <ElForm
        ref="registerFormRef"
        :model="form"
        :rules="formRules"
        label-position="top"
        class="password-register-verify-view__form w-full"
        @submit.prevent="handleSubmitRegistration"
      >
        <ElFormItem :label="t('auth.common.registerEmail')" prop="email">
          <ElInput v-model="form.email" disabled />
        </ElFormItem>
        <ElFormItem :label="t('auth.common.verificationCode')" prop="code">
          <ElInput
            v-model="form.code"
            maxlength="6"
            :placeholder="t('auth.registerVerify.verificationCodePlaceholder')"
            :disabled="!isReady || isSubmitting"
          />
        </ElFormItem>
        <ElFormItem :label="t('auth.common.displayName')" prop="displayName">
          <ElInput
            v-model="form.displayName"
            autocomplete="nickname"
            :placeholder="t('auth.registerVerify.displayNamePlaceholder')"
            :disabled="!isReady || isSubmitting"
          />
        </ElFormItem>
        <ElFormItem :label="t('auth.common.password')" prop="password">
          <ElInput
            v-model="form.password"
            type="password"
            show-password
            autocomplete="new-password"
            :placeholder="t('auth.registerVerify.passwordPlaceholder')"
            :disabled="!isReady || isSubmitting"
          />
        </ElFormItem>
        <ElFormItem :label="t('auth.common.confirmPassword')" prop="confirmPassword">
          <ElInput
            v-model="form.confirmPassword"
            type="password"
            show-password
            autocomplete="new-password"
            :placeholder="t('auth.registerVerify.confirmPasswordPlaceholder')"
            :disabled="!isReady || isSubmitting"
          />
        </ElFormItem>
        <ElButton
          type="primary"
          native-type="submit"
          class="password-register-verify-view__submit w-full min-h-[2.875rem]"
          :loading="isSubmitting"
          :disabled="!isReady"
        >
          {{ t('auth.registerVerify.submit') }}
        </ElButton>
      </ElForm>
    </div>

    <template #footer>
      <span class="password-register-verify-view__footer-text text-secondary">{{ t('auth.common.existingAccount') }}</span>
      <RouterLink :to="{ name: 'login' }" class="password-register-verify-view__footer-link text-primary font-semibold no-underline">
        {{ t('auth.common.returnLogin') }}
      </RouterLink>
    </template>
  </AuthEntryShell>
</template>
