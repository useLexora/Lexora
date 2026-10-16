import type { AuthProviderName } from '@haohaoxue/lexora-contracts/auth'
import type { UserSettings } from '@haohaoxue/lexora-contracts/user'
import {
  AUTH_PROVIDER_VALUES,
  OAUTH_REDIRECT_BIND_STATUS,
  OAUTH_REDIRECT_QUERY,
} from '@haohaoxue/lexora-contracts/auth/constants'
import { formatAuthMethod, normalizeAuthProviderName } from '@haohaoxue/lexora-shared/auth'
import { createSharedComposable } from '@vueuse/core'
import { computed, reactive, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { requestBindEmailCode, startOauthBinding } from '@/apis/user'
import { useUserStore } from '@/stores/user'
import { ElMessage } from '@/utils/element-plus'
import { resolveOAuthRedirectErrorMessage } from '@/utils/oauth-redirect'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import { useSettingsAuthCapabilities } from './useSettingsAuthCapabilities'

function createDefaultAccount(): UserSettings['account'] {
  return {
    email: null,
    userCode: '',
    hasPasswordAuth: false,
    emailVerified: false,
    oauthProviders: Object.fromEntries(AUTH_PROVIDER_VALUES.map(provider => [provider, {
      connected: false,
      username: null,
    }])) as UserSettings['account']['oauthProviders'],
  }
}

function formatProviderLabel(provider: string, fallbackProviderLabel: string) {
  const normalizedProvider = normalizeAuthProviderName(provider)

  if (normalizedProvider) {
    return formatAuthMethod(normalizedProvider)
  }

  return fallbackProviderLabel
}

export const useSettingsUserAccount = createSharedComposable(() => {
  const { t } = useI18n({ useScope: 'global' })
  const route = useRoute()
  const router = useRouter()
  const userStore = useUserStore()
  const { authCapabilities } = useSettingsAuthCapabilities()
  const isSendingEmailCode = shallowRef(false)
  const isBindingEmail = shallowRef(false)
  const bindingProvider = shallowRef<AuthProviderName | null>(null)
  const disconnectingProvider = shallowRef<AuthProviderName | null>(null)
  const emailForm = reactive({
    email: '',
    code: '',
    newPassword: '',
    confirmPassword: '',
  })

  const settings = computed(() => userStore.settings)
  const account = computed<UserSettings['account']>(() => settings.value?.account ?? createDefaultAccount())
  const emailBindingEnabled = computed(() => authCapabilities.value.emailBindingEnabled)
  const oauthProviderBindingState = computed(() => Object.fromEntries(AUTH_PROVIDER_VALUES.map((provider) => {
    const connectedOauthCount = AUTH_PROVIDER_VALUES.filter(item => account.value.oauthProviders[item].connected).length

    return [provider, {
      canStartBinding: authCapabilities.value.providers[provider].enabled,
      canDisconnect: account.value.oauthProviders[provider].connected
        && (account.value.hasPasswordAuth || connectedOauthCount > 1),
    }]
  })) as Record<AuthProviderName, { canStartBinding: boolean, canDisconnect: boolean }>)

  function syncEmailForm() {
    const nextSettings = userStore.settings

    if (!nextSettings) {
      return
    }

    emailForm.email = nextSettings.account.email || ''
    emailForm.code = ''
    emailForm.newPassword = ''
    emailForm.confirmPassword = ''
  }

  async function sendEmailCode() {
    isSendingEmailCode.value = true

    try {
      await requestBindEmailCode({
        email: emailForm.email.trim(),
      })
      ElMessage.success(t('settings.user.account.emailSent'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.account.sendCodeFailed')))
    }
    finally {
      isSendingEmailCode.value = false
    }
  }

  async function bindEmail() {
    isBindingEmail.value = true
    const hadEmail = Boolean(account.value.email)

    try {
      await userStore.bindEmail({
        email: emailForm.email.trim(),
        code: emailForm.code.trim(),
        newPassword: emailForm.newPassword.trim() || undefined,
      })

      syncEmailForm()
      ElMessage.success(hadEmail ? t('settings.user.account.emailUpdated') : t('settings.user.account.emailBound'))
      return true
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.account.bindEmailFailed')))
      return false
    }
    finally {
      isBindingEmail.value = false
    }
  }

  async function connectOauth(provider: AuthProviderName) {
    bindingProvider.value = provider

    try {
      const result = await startOauthBinding(provider, {
        redirectPath: route.fullPath,
      })
      window.location.assign(result.authorizeUrl)
    }
    catch (error) {
      bindingProvider.value = null
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.account.bindProviderFailed')))
    }
  }

  async function disconnectOauth(provider: AuthProviderName) {
    disconnectingProvider.value = provider

    try {
      await userStore.disconnectOauth(provider)
      syncEmailForm()
      ElMessage.success(t('settings.user.account.providerDisconnected', {
        provider: formatProviderLabel(provider, t('settings.user.account.fallbackProvider')),
      }))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.account.disconnectFailed')))
    }
    finally {
      disconnectingProvider.value = null
    }
  }

  async function consumeRouteFeedback() {
    const bindStatus = ((route.query[OAUTH_REDIRECT_QUERY.BIND_STATUS] as string | null | undefined) ?? '').trim()
    const provider = ((route.query[OAUTH_REDIRECT_QUERY.PROVIDER] as string | null | undefined) ?? '').trim()
    const bindErrorCode = ((route.query[OAUTH_REDIRECT_QUERY.BIND_ERROR_CODE] as string | null | undefined) ?? '').trim()

    if (!bindStatus) {
      return
    }

    const nextQuery = { ...route.query }
    delete nextQuery[OAUTH_REDIRECT_QUERY.BIND_STATUS]
    delete nextQuery[OAUTH_REDIRECT_QUERY.PROVIDER]
    delete nextQuery[OAUTH_REDIRECT_QUERY.BIND_ERROR_CODE]
    await router.replace({ query: nextQuery })

    const providerLabel = formatProviderLabel(provider, t('settings.user.account.fallbackProvider'))

    if (bindStatus === OAUTH_REDIRECT_BIND_STATUS.SUCCESS) {
      ElMessage.success(t('settings.user.account.providerBound', { provider: providerLabel }))
      return
    }

    ElMessage.error(resolveOAuthRedirectErrorMessage(bindErrorCode, {
      purpose: 'bind',
      providerLabel,
      fallbackMessage: t('oauthRedirect.bindFailed', { provider: providerLabel }),
    }))
  }

  return {
    account,
    bindEmail,
    bindingProvider,
    connectOauth,
    consumeRouteFeedback,
    disconnectOauth,
    disconnectingProvider,
    emailBindingEnabled,
    emailForm,
    isBindingEmail,
    isSendingEmailCode,
    oauthProviderBindingState,
    sendEmailCode,
    syncEmailForm,
  }
})
