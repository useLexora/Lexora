<script setup lang="ts">
import type { FormInstance } from 'element-plus'
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useRegister } from '../../composables/useRegister'
import AuthEntryShell from '../../layouts/entry-shell'

const router = useRouter()
const registerRequestFormRef = useTemplateRef<FormInstance>('registerRequestFormRef')
const { t } = useI18n({ useScope: 'global' })
const {
  form,
  formRules,
  handleSubmitEmailVerificationRequest,
  isLoadingCapabilities,
  isSubmitting,
  loadErrorMessage,
  passwordRegistrationInviteCodeRequired,
  passwordRegistrationEnabled,
} = useRegister({
  registerRequestFormRef,
})

const isRegistrationClosed = computed(() => !isLoadingCapabilities.value && !passwordRegistrationEnabled.value)
const pageTitle = computed(() => isRegistrationClosed.value ? t('auth.register.closedTitle') : t('auth.register.title'))
const pageDescription = computed(() => {
  if (isRegistrationClosed.value) {
    return t('auth.register.closedDescription')
  }

  if (passwordRegistrationInviteCodeRequired.value) {
    return t('auth.register.descriptionWithInvite')
  }

  return t('auth.register.description')
})

function goToLogin() {
  void router.push({ name: 'login' })
}
</script>

<template>
  <AuthEntryShell
    :title="pageTitle"
    :description="pageDescription"
  >
    <ElAlert
      v-if="loadErrorMessage"
      :title="loadErrorMessage"
      type="error"
      show-icon
      :closable="false"
      class="password-register-view__alert mb-4"
    />

    <template v-else>
      <ElResult
        v-if="isRegistrationClosed"
        icon="warning"
        :title="t('auth.register.closedResultTitle')"
        :sub-title="t('auth.register.closedResultSubtitle')"
        class="password-register-view__closed-result !p-0"
      >
        <template #extra>
          <ElButton type="primary" @click="goToLogin">
            {{ t('auth.common.returnLogin') }}
          </ElButton>
        </template>
      </ElResult>

      <ElSkeleton v-else-if="isLoadingCapabilities" animated class="w-full">
        <template #template>
          <div class="grid gap-4">
            <ElSkeletonItem variant="rect" class="h-10 w-full" />
            <ElSkeletonItem variant="rect" class="h-10 w-full" />
            <ElSkeletonItem variant="button" class="h-12 w-full" />
          </div>
        </template>
      </ElSkeleton>

      <template v-else>
        <ElForm
          ref="registerRequestFormRef"
          :model="form"
          :rules="formRules"
          label-position="top"
          class="password-register-view__form w-full"
          @submit.prevent="handleSubmitEmailVerificationRequest"
        >
          <ElFormItem :label="t('auth.common.registerEmail')" prop="email">
            <ElInput
              v-model="form.email"
              autocomplete="email"
              size="large"
              :placeholder="t('auth.common.emailPlaceholder')"
              :disabled="isSubmitting"
            />
          </ElFormItem>
          <ElFormItem v-if="passwordRegistrationInviteCodeRequired" :label="t('auth.common.inviteCode')" prop="inviteCode">
            <ElInput
              v-model="form.inviteCode"
              autocomplete="off"
              size="large"
              :placeholder="t('auth.common.inviteCodePlaceholder')"
              :disabled="isSubmitting"
            />
          </ElFormItem>

          <ElButton
            type="primary"
            native-type="submit"
            size="large"
            class="password-register-view__submit mt-2 w-full min-h-12 font-semibold"
            :loading="isSubmitting"
          >
            {{ t('auth.register.sendCode') }}
          </ElButton>
        </ElForm>
      </template>
    </template>

    <template #footer>
      <template v-if="loadErrorMessage || isLoadingCapabilities || passwordRegistrationEnabled">
        <span class="password-register-view__footer-text text-secondary">{{ t('auth.register.alreadyHaveAccount') }}</span>
        <RouterLink :to="{ name: 'login' }" class="password-register-view__footer-link text-primary font-semibold no-underline">
          {{ t('auth.common.returnLogin') }}
        </RouterLink>
      </template>
    </template>
  </AuthEntryShell>
</template>

<style scoped lang="scss">
.password-register-view {
  &__submit {
    border-radius: 7px;
    box-shadow: 0 18px 30px -24px color-mix(in srgb, var(--brand-primary) 45%, transparent);
    letter-spacing: 0;
  }
}
</style>
