import type { AuthCapabilities } from '@/apis/capabilities'
import { AUTH_PROVIDER_VALUES } from '@haohaoxue/lexora-contracts/auth/constants'
import { createSharedComposable } from '@vueuse/core'
import { shallowRef } from 'vue'
import { getAuthCapabilities } from '@/apis/capabilities'

export const DEFAULT_AUTH_CAPABILITIES: AuthCapabilities = {
  emailBindingEnabled: false,
  passwordRegistrationEnabled: false,
  passwordRegistrationInviteCodeRequired: false,
  providers: Object.fromEntries(AUTH_PROVIDER_VALUES.map(provider => [provider, {
    enabled: false,
    allowRegistration: false,
    inviteCodeRequired: false,
  }])) as AuthCapabilities['providers'],
}

export const useSettingsAuthCapabilities = createSharedComposable(() => {
  const authCapabilities = shallowRef<AuthCapabilities>(DEFAULT_AUTH_CAPABILITIES)

  async function loadAuthCapabilities() {
    authCapabilities.value = DEFAULT_AUTH_CAPABILITIES
    const next = await getAuthCapabilities().catch(() => null)
    authCapabilities.value = next ?? DEFAULT_AUTH_CAPABILITIES
  }

  return {
    authCapabilities,
    loadAuthCapabilities,
  }
})
