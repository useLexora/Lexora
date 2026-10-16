import { OAUTH_REDIRECT_QUERY } from '@haohaoxue/lexora-contracts/auth/constants'
import { computed, onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { resolveOAuthRedirectErrorMessage } from '@/utils/oauth-redirect'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import { completeAuthNavigation } from '../utils/navigation'

export function useCallback() {
  const { t } = useI18n({ useScope: 'global' })
  const route = useRoute()
  const router = useRouter()
  const authStore = useAuthStore()
  const statusLabelKey = shallowRef('auth.callback.processing')
  const errorMessage = shallowRef('')
  const statusLabel = computed(() => t(statusLabelKey.value))
  const pageDescription = computed(() =>
    errorMessage.value ? t('auth.callback.retryDescription') : t('auth.callback.processingDescription'),
  )

  async function handleCallback() {
    const redirectErrorCode = ((route.query[OAUTH_REDIRECT_QUERY.ERROR_CODE] as string | null | undefined) ?? '').trim()
    const code = ((route.query[OAUTH_REDIRECT_QUERY.LOGIN_CODE] as string | null | undefined) ?? '').trim()

    if (redirectErrorCode) {
      statusLabelKey.value = 'auth.callback.failed'
      errorMessage.value = resolveOAuthRedirectErrorMessage(redirectErrorCode, {
        purpose: 'login',
      })
      return
    }

    if (!code) {
      statusLabelKey.value = 'auth.callback.invalid'
      errorMessage.value = t('auth.callback.missingCode')
      return
    }

    try {
      await authStore.login(code)
      statusLabelKey.value = 'auth.callback.successRedirecting'
      await completeAuthNavigation(router, authStore)
    }
    catch (error) {
      statusLabelKey.value = 'auth.callback.failed'
      errorMessage.value = getRequestErrorDisplayMessage(error, t('auth.callback.failed'))
    }
  }

  onMounted(handleCallback)

  return {
    pageDescription,
    statusLabel,
    errorMessage,
  }
}
