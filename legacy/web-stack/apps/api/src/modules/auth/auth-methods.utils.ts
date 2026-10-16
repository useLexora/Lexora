import type { AuthMethodName } from '@haohaoxue/lexora-contracts'
import { AUTH_METHOD, AUTH_METHOD_VALUES } from '@haohaoxue/lexora-contracts'
import { AuthProvider } from '@prisma/client'

const AUTH_PROVIDER_TO_METHOD: Record<AuthProvider, AuthMethodName> = {
  [AuthProvider.GOOGLE]: AUTH_METHOD.GOOGLE,
  [AuthProvider.GITHUB]: AUTH_METHOD.GITHUB,
  [AuthProvider.LINUX_DO]: AUTH_METHOD.LINUX_DO,
}

export function resolveAuthMethod(provider: AuthProvider): AuthMethodName {
  return AUTH_PROVIDER_TO_METHOD[provider]
}

export function resolveAuthMethods(
  hasLocalCredential: boolean,
  oauthAccounts: Array<{ provider: AuthProvider }>,
): AuthMethodName[] {
  const methods = new Set<AuthMethodName>()

  if (hasLocalCredential) {
    methods.add(AUTH_METHOD.PASSWORD)
  }

  for (const account of oauthAccounts) {
    methods.add(resolveAuthMethod(account.provider))
  }

  return AUTH_METHOD_VALUES.filter(method => methods.has(method))
}
