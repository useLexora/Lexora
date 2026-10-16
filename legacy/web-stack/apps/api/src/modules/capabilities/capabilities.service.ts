import type { AuthCapabilities as AuthCapabilitiesView } from '@haohaoxue/lexora-contracts'
import type { OAuthConfig, OAuthProviderConfig } from '../../config/auth.config'
import { AUTH_PROVIDER, AUTH_PROVIDER_VALUES } from '@haohaoxue/lexora-contracts'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SystemAuthService } from '../auth/system-auth.service'
import { SystemEmailService } from '../system-email/system-email.service'

@Injectable()
export class CapabilitiesService {
  constructor(
    private readonly systemAuthService: SystemAuthService,
    private readonly systemEmailService: SystemEmailService,
    private readonly configService: ConfigService,
  ) {}

  async getAuthCapabilities(): Promise<AuthCapabilitiesView> {
    const [registrationOptions, emailBindingEnabled] = await Promise.all([
      this.systemAuthService.getRegistrationOptions(),
      this.systemEmailService.isEnabled(),
    ])
    const oauthConfig = this.configService.getOrThrow<OAuthConfig>('oauth')
    const passwordRegistrationEnabled = emailBindingEnabled && registrationOptions.allowPasswordRegistration
    const providers = Object.fromEntries(AUTH_PROVIDER_VALUES.map((provider) => {
      const providerOptions = registrationOptions.oauthProviders[provider]
      const enabled = isOAuthProviderEnabled(resolveOAuthProviderConfig(oauthConfig, provider)) && providerOptions.allowLogin
      const allowRegistration = enabled && providerOptions.allowRegistration

      return [provider, {
        enabled,
        allowRegistration,
        inviteCodeRequired: allowRegistration && providerOptions.requireInviteCode,
      }]
    })) as AuthCapabilitiesView['providers']

    return {
      emailBindingEnabled,
      passwordRegistrationEnabled,
      passwordRegistrationInviteCodeRequired: passwordRegistrationEnabled && registrationOptions.requirePasswordInviteCode,
      providers,
    }
  }
}

function isOAuthProviderEnabled(config: OAuthProviderConfig): boolean {
  return Boolean(config.clientId?.trim() && config.clientSecret?.trim())
}

function resolveOAuthProviderConfig(config: OAuthConfig, provider: (typeof AUTH_PROVIDER_VALUES)[number]): OAuthProviderConfig {
  if (provider === AUTH_PROVIDER.LINUX_DO) {
    return config.linuxDo
  }

  return config[provider]
}
