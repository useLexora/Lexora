import type { FormInstance, FormRules } from 'element-plus'
import type { ShallowRef } from 'vue'
import { AUTH_METHOD } from '@haohaoxue/lexora-contracts/auth/constants'
import { computed, onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { createRegistrationInviteGrant, requestEmailVerification } from '@/apis/auth'
import { useFormSubmit } from '@/composables/useFormSubmit'
import { ElMessage } from '@/utils/element-plus'
import { clearPasswordRegistrationInviteGrant, savePasswordRegistrationInviteGrant } from '../utils/registration-invite'
import { createAuthRuleMessages, createEmailRules, isValidEmail } from '../utils/rules'
import { useAuthCapabilities } from './useAuthCapabilities'

export function useRegister(options: { registerRequestFormRef: ShallowRef<FormInstance | null> }) {
  const { t } = useI18n({ useScope: 'global' })
  const router = useRouter()
  const form = reactive({
    email: '',
    inviteCode: '',
  })
  const ruleMessages = createAuthRuleMessages((key, params) => params ? t(key, params) : t(key))
  const formRules = computed<FormRules<typeof form>>(() => ({
    email: createEmailRules(t('auth.common.email'), ruleMessages),
    inviteCode: [
      {
        required: true,
        message: t('auth.validation.inviteCodeRequired'),
      },
      {
        min: 4,
        message: t('auth.validation.inviteCodeMin', { min: 4 }),
      },
    ],
  }))
  const {
    isLoadingCapabilities,
    loadErrorMessage,
    loadCapabilities,
    passwordRegistrationInviteCodeRequired,
    passwordRegistrationEnabled,
  } = useAuthCapabilities()

  const { isSubmitting, submit: submitEmailVerificationRequest } = useFormSubmit({
    validate: () =>
      passwordRegistrationEnabled.value
      && isValidEmail(form.email.trim())
      && (!passwordRegistrationInviteCodeRequired.value || Boolean(form.inviteCode.trim())),
    action: async () => {
      form.email = form.email.trim()
      form.inviteCode = form.inviteCode.trim()
      const registrationInviteGrantToken = passwordRegistrationInviteCodeRequired.value
        ? await createPasswordRegistrationInviteGrant()
        : undefined

      await requestEmailVerification({
        email: form.email,
        registrationInviteGrantToken,
      })

      if (registrationInviteGrantToken) {
        savePasswordRegistrationInviteGrant({
          email: form.email,
          token: registrationInviteGrantToken,
        })
      }
      else {
        clearPasswordRegistrationInviteGrant()
      }

      ElMessage.success(t('auth.register.verificationSent'))
      await router.push({
        name: 'register-verify',
        query: {
          email: form.email,
        },
      })
    },
    fallbackError: () => t('auth.register.sendCodeFailed'),
  })

  onMounted(() => {
    void loadCapabilities()
  })

  async function handleSubmitEmailVerificationRequest() {
    await submitEmailVerificationRequest(options.registerRequestFormRef.value)
  }

  return {
    form,
    formRules,
    handleSubmitEmailVerificationRequest,
    isLoadingCapabilities,
    isSubmitting,
    loadErrorMessage,
    passwordRegistrationInviteCodeRequired,
    passwordRegistrationEnabled,
    submitEmailVerificationRequest,
  }

  async function createPasswordRegistrationInviteGrant() {
    const grant = await createRegistrationInviteGrant({
      method: AUTH_METHOD.PASSWORD,
      email: form.email,
      inviteCode: form.inviteCode,
    })

    return grant.grantToken
  }
}
