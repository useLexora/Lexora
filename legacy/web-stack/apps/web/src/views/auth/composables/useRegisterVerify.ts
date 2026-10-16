import type { FormInstance, FormRules } from 'element-plus'
import type { ShallowRef } from 'vue'
import { computed, onMounted, reactive, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useFormSubmit } from '@/composables/useFormSubmit'
import { useAuthStore } from '@/stores/auth'
import { completeAuthNavigation } from '../utils/navigation'
import { clearPasswordRegistrationInviteGrant, consumePasswordRegistrationInviteGrant } from '../utils/registration-invite'
import {
  createAuthRuleMessages,
  createConfirmPasswordRules,
  createDisplayNameRules,
  createEmailRules,
  createPasswordRules,
  isValidDisplayName,
  isValidEmail,
  isValidPassword,
} from '../utils/rules'

const EMAIL_VERIFICATION_CODE_RE = /^\d{6}$/

export function useRegisterVerify(options: { registerFormRef: ShallowRef<FormInstance | null> }) {
  const { t } = useI18n({ useScope: 'global' })
  const route = useRoute()
  const router = useRouter()
  const authStore = useAuthStore()
  const statusLabelKey = shallowRef('auth.registerVerify.title')
  const errorMessage = shallowRef('')
  const form = reactive({
    email: '',
    code: '',
    displayName: '',
    password: '',
    confirmPassword: '',
  })
  const ruleMessages = createAuthRuleMessages((key, params) => params ? t(key, params) : t(key))
  const formRules = computed<FormRules<typeof form>>(() => ({
    email: createEmailRules(t('auth.common.registerEmail'), ruleMessages),
    code: [
      {
        required: true,
        message: t('auth.validation.codeRequired'),
      },
      {
        pattern: EMAIL_VERIFICATION_CODE_RE,
        message: t('auth.validation.codeInvalid'),
      },
    ],
    displayName: createDisplayNameRules(t('auth.common.displayName'), ruleMessages),
    password: createPasswordRules(t('auth.common.password'), ruleMessages),
    confirmPassword: createConfirmPasswordRules(
      () => form.password,
      t('auth.common.confirmPassword'),
      t('auth.validation.confirmPasswordMismatch'),
      ruleMessages,
    ),
  }))

  const routeEmail = computed(() => typeof route.query.email === 'string' ? route.query.email.trim() : '')
  const isReady = computed(() => Boolean(form.email) && !errorMessage.value)
  const statusLabel = computed(() => t(statusLabelKey.value))
  const pageDescription = computed(() => {
    if (errorMessage.value) {
      return t('auth.registerVerify.invalidDescription')
    }

    return t('auth.registerVerify.description')
  })

  function initEmail() {
    if (!routeEmail.value || !isValidEmail(routeEmail.value)) {
      statusLabelKey.value = 'auth.registerVerify.invalidTitle'
      errorMessage.value = t('auth.registerVerify.missingEmail')
      return
    }

    form.email = routeEmail.value
  }

  const { isSubmitting, submit: submitRegistration } = useFormSubmit({
    validate: () =>
      isReady.value
      && isValidEmail(form.email)
      && EMAIL_VERIFICATION_CODE_RE.test(form.code.trim())
      && isValidDisplayName(form.displayName.trim())
      && isValidPassword(form.password)
      && form.confirmPassword === form.password,
    action: async () => {
      form.displayName = form.displayName.trim()
      form.code = form.code.trim()
      await authStore.passwordRegister(
        form.email,
        form.code,
        form.displayName,
        form.password,
        consumePasswordRegistrationInviteGrant(form.email),
      )
    },
    fallbackError: () => t('auth.registerVerify.failed'),
    onSuccess: () => {
      clearPasswordRegistrationInviteGrant()
      return completeAuthNavigation(router, authStore)
    },
  })

  onMounted(() => {
    initEmail()
  })

  async function handleSubmitRegistration() {
    await submitRegistration(options.registerFormRef.value)
  }

  return {
    errorMessage,
    form,
    formRules,
    handleSubmitRegistration,
    isReady,
    isSubmitting,
    pageDescription,
    statusLabel,
    submitRegistration,
  }
}
