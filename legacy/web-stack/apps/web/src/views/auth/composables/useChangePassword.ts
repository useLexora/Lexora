import type { FormInstance, FormRules } from 'element-plus'
import type { Ref } from 'vue'
import { computed, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useFormSubmit } from '@/composables/useFormSubmit'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { completeAuthNavigation } from '../utils/navigation'
import {
  createAuthRuleMessages,
  createConfirmPasswordRules,
  createDifferentPasswordRule,
  createPasswordRules,
  isValidPassword,
} from '../utils/rules'

export function useChangePassword(options: {
  changePasswordFormRef: Ref<FormInstance | null>
}) {
  const { t } = useI18n({ useScope: 'global' })
  const router = useRouter()
  const authStore = useAuthStore()
  const userStore = useUserStore()
  const form = reactive({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  })
  const ruleMessages = createAuthRuleMessages((key, params) => params ? t(key, params) : t(key))
  const formRules = computed<FormRules<typeof form>>(() => ({
    currentPassword: createPasswordRules(t('auth.changePassword.currentPassword'), ruleMessages),
    newPassword: [
      ...createPasswordRules(t('auth.changePassword.newPassword'), ruleMessages),
      createDifferentPasswordRule(
        () => form.currentPassword,
        t('auth.validation.differentPassword'),
        ruleMessages,
      ),
    ],
    confirmPassword: createConfirmPasswordRules(
      () => form.newPassword,
      t('auth.changePassword.confirmNewPassword'),
      t('auth.validation.confirmNewPasswordMismatch'),
      {
        ...ruleMessages,
        confirmPasswordMismatch: () => t('auth.validation.confirmNewPasswordMismatch'),
      },
    ),
  }))

  const { isSubmitting, submit: submitChangePassword } = useFormSubmit({
    validate: () =>
      isValidPassword(form.currentPassword)
      && isValidPassword(form.newPassword)
      && form.confirmPassword === form.newPassword
      && form.currentPassword !== form.newPassword,
    action: () => authStore.updatePassword(form.currentPassword, form.newPassword),
    fallbackError: () => t('auth.changePassword.failed'),
    onSuccess: () => completeAuthNavigation(router, authStore),
  })

  const requiresPasswordChange = computed(() => userStore.requiresPasswordChange)
  const pageDescription = computed(() =>
    requiresPasswordChange.value ? t('auth.changePassword.firstLoginDescription') : t('auth.changePassword.defaultDescription'),
  )

  async function handleSubmitChangePassword() {
    await submitChangePassword(options.changePasswordFormRef.value)
  }

  return {
    form,
    formRules,
    handleSubmitChangePassword,
    isSubmitting,
    pageDescription,
    requiresPasswordChange,
    submitChangePassword,
  }
}
