import { OAUTH_REDIRECT_ERROR_CODE } from '@haohaoxue/lexora-contracts/auth/constants'
import { translate } from '@/i18n'

interface ResolveOAuthRedirectErrorMessageOptions {
  purpose: 'login' | 'bind'
  providerLabel?: string
  fallbackMessage?: string
}

export function resolveOAuthRedirectErrorMessage(
  errorCode: string | null | undefined,
  options: ResolveOAuthRedirectErrorMessageOptions,
): string {
  const normalizedErrorCode = errorCode?.trim()
  const fallbackMessage = options.fallbackMessage
    ?? (options.purpose === 'bind'
      ? translate('oauthRedirect.bindFailed', {
          provider: options.providerLabel ?? translate('oauthRedirect.thirdPartyAccount'),
        })
      : translate('oauthRedirect.loginFailedRetry'))

  if (!normalizedErrorCode) {
    return fallbackMessage
  }

  if (normalizedErrorCode === OAUTH_REDIRECT_ERROR_CODE.CALLBACK_FAILED) {
    if (options.purpose === 'bind') {
      return translate('oauthRedirect.bindFailedRetry', {
        provider: options.providerLabel ?? translate('oauthRedirect.thirdPartyAccount'),
      })
    }

    return translate('oauthRedirect.loginFailedRetry')
  }

  if (normalizedErrorCode === OAUTH_REDIRECT_ERROR_CODE.REGISTRATION_INVITE_REQUIRED) {
    if (options.purpose === 'bind') {
      return translate('oauthRedirect.bindFailedRetry', {
        provider: options.providerLabel ?? translate('oauthRedirect.thirdPartyAccount'),
      })
    }

    return translate('oauthRedirect.registrationInviteRequired')
  }

  return fallbackMessage
}
