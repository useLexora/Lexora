import type { AuthProviderName } from '@haohaoxue/lexora-contracts'
import type { FormInstance, FormRules } from 'element-plus'
import type { ShallowRef } from 'vue'
import { AUTH_PROVIDER_VALUES } from '@haohaoxue/lexora-contracts/auth/constants'
import { computed, onMounted, reactive, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { createRegistrationInviteGrant, startOAuthLogin } from '@/apis/auth'
import { useFormSubmit } from '@/composables/useFormSubmit'
import { useAuthStore } from '@/stores/auth'
import { ElMessage, ElMessageBox } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import { completeAuthNavigation, syncPendingRedirect } from '../utils/navigation'
import { AUTH_PROVIDER_UI_META } from '../utils/provider-ui'
import { createAuthRuleMessages, createEmailRules, createPasswordRules, isValidEmail, isValidPassword } from '../utils/rules'
import { useAuthCapabilities } from './useAuthCapabilities'

export function useLogin(options: {
  oauthInviteFormRef: ShallowRef<FormInstance | null>
  passwordFormRef: ShallowRef<FormInstance | null>
}) {
  const { t } = useI18n({ useScope: 'global' })
  const route = useRoute()
  const router = useRouter()
  const authStore = useAuthStore()
  const selectedOauthProvider = shallowRef<AuthProviderName | null>(null)
  const isOauthInviteDialogVisible = shallowRef(false)
  const startingOauthProvider = shallowRef<AuthProviderName | null>(null)
  const passwordForm = reactive({
    email: '',
    password: '',
  })
  const oauthInviteForm = reactive({
    inviteCode: '',
  })
  const ruleMessages = createAuthRuleMessages((key, params) => params ? t(key, params) : t(key))
  const passwordFormRules = computed<FormRules<typeof passwordForm>>(() => ({
    email: createEmailRules(t('auth.common.email'), ruleMessages),
    password: createPasswordRules(t('auth.common.password'), ruleMessages),
  }))
  const oauthInviteFormRules = computed<FormRules<typeof oauthInviteForm>>(() => ({
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
    authCapabilities,
    isLoadingCapabilities,
    loadErrorMessage,
    loadCapabilities,
    passwordRegistrationEnabled,
  } = useAuthCapabilities()

  const providers = computed(() => AUTH_PROVIDER_VALUES
    .filter(provider => authCapabilities.value?.providers[provider].enabled ?? false)
    .map((provider) => {
      const providerMeta = AUTH_PROVIDER_UI_META[provider]
      const acceptingNewUsers = authCapabilities.value?.providers[provider].allowRegistration ?? false
      const inviteCodeRequired = authCapabilities.value?.providers[provider].inviteCodeRequired ?? false

      return {
        provider,
        acceptingNewUsers,
        inviteCodeRequired,
        ...providerMeta,
      }
    }))
  const hasOauthProviders = computed(() => providers.value.length > 0)
  const selectedOauthProviderMeta = computed(() =>
    selectedOauthProvider.value ? AUTH_PROVIDER_UI_META[selectedOauthProvider.value] : null,
  )

  const { isSubmitting: isPasswordSubmitting, submit: submitPasswordLogin } = useFormSubmit({
    validate: () => isValidEmail(passwordForm.email) && isValidPassword(passwordForm.password),
    action: async () => {
      syncPendingRedirect(route.query.redirect, authStore)
      passwordForm.email = passwordForm.email.trim()
      await authStore.passwordLogin(passwordForm.email, passwordForm.password)
    },
    fallbackError: () => t('auth.login.failed'),
    onSuccess: () => completeAuthNavigation(router, authStore),
  })

  async function startLogin(provider: AuthProviderName, registrationInviteGrantToken?: string) {
    syncPendingRedirect(route.query.redirect, authStore)
    startingOauthProvider.value = provider

    try {
      const result = await startOAuthLogin(provider, registrationInviteGrantToken
        ? { registrationInviteGrantToken }
        : {})
      window.location.assign(result.authorizeUrl)
    }
    catch (error) {
      startingOauthProvider.value = null
      ElMessage.error(getRequestErrorDisplayMessage(error, t('auth.login.startOauthFailed')))
    }
  }

  async function handleStartLogin(provider: AuthProviderName) {
    const targetProvider = providers.value.find(item => item.provider === provider)

    if (!targetProvider) {
      return
    }

    if (!targetProvider.acceptingNewUsers) {
      const isConfirmed = await ElMessageBox.confirm(
        t('auth.login.oauthExistingOnlyMessage', { provider: targetProvider.title }),
        t('auth.login.oauthDialogTitle', { provider: targetProvider.title }),
        {
          confirmButtonText: t('auth.login.continueLogin'),
          cancelButtonText: t('auth.common.cancel'),
          type: 'info',
          autofocus: false,
        },
      ).then(() => true).catch(() => false)

      if (!isConfirmed) {
        return
      }

      void startLogin(provider)
      return
    }

    if (targetProvider?.acceptingNewUsers && targetProvider.inviteCodeRequired) {
      selectedOauthProvider.value = provider
      oauthInviteForm.inviteCode = ''
      options.oauthInviteFormRef.value?.clearValidate()
      isOauthInviteDialogVisible.value = true
      return
    }
    void startLogin(provider)
  }

  async function continueOauthWithInviteCode() {
    const provider = selectedOauthProvider.value

    if (!provider) {
      return
    }

    const isValid = await options.oauthInviteFormRef.value?.validate().catch(() => false)

    if (!isValid) {
      return
    }

    startingOauthProvider.value = provider

    try {
      const grant = await createRegistrationInviteGrant({
        method: provider,
        inviteCode: oauthInviteForm.inviteCode.trim(),
      })
      isOauthInviteDialogVisible.value = false
      await startLogin(provider, grant.grantToken)
    }
    catch (error) {
      startingOauthProvider.value = null
      ElMessage.error(getRequestErrorDisplayMessage(error, t('auth.login.verifyInviteFailed')))
    }
  }

  function continueOauthAsExistingAccount() {
    const provider = selectedOauthProvider.value

    if (!provider) {
      return
    }

    isOauthInviteDialogVisible.value = false
    void startLogin(provider)
  }

  async function handleSubmitPasswordLogin() {
    await submitPasswordLogin(options.passwordFormRef.value)
  }

  onMounted(() => {
    syncPendingRedirect(route.query.redirect, authStore)
    void loadCapabilities()
  })

  return {
    continueOauthAsExistingAccount,
    continueOauthWithInviteCode,
    handleSubmitPasswordLogin,
    handleStartLogin,
    hasOauthProviders,
    isOauthInviteDialogVisible,
    isLoadingCapabilities,
    isPasswordSubmitting,
    loadErrorMessage,
    oauthInviteForm,
    oauthInviteFormRules,
    passwordRegistrationEnabled,
    passwordForm,
    passwordFormRules,
    providers,
    selectedOauthProviderMeta,
    startLogin,
    startingOauthProvider,
    submitPasswordLogin,
  }
}
