import type { AuthMethodName, AuthProviderName } from '@haohaoxue/lexora-contracts'
import { AUTH_METHOD_LABELS, AUTH_PROVIDER_ALIAS_MAP, AUTH_PROVIDER_VALUES } from '@haohaoxue/lexora-contracts/auth/constants'

const NON_ALPHANUMERIC_RE = /[^a-z0-9]+/g

export function isAuthProviderName(value: string): value is AuthProviderName {
  return AUTH_PROVIDER_VALUES.includes(value as AuthProviderName)
}

export function normalizeAuthProviderName(value: string): AuthProviderName | null {
  const normalizedValue = value.trim().toLowerCase()

  if (isAuthProviderName(normalizedValue)) {
    return normalizedValue
  }

  const compactValue = normalizedValue.replace(NON_ALPHANUMERIC_RE, '')

  if (compactValue in AUTH_PROVIDER_ALIAS_MAP) {
    return AUTH_PROVIDER_ALIAS_MAP[compactValue as keyof typeof AUTH_PROVIDER_ALIAS_MAP]
  }

  return null
}

export function formatAuthMethod(method: AuthMethodName): string {
  return AUTH_METHOD_LABELS[method]
}
