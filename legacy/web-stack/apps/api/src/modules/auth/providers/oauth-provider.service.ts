import type { AuthProviderName } from '@haohaoxue/lexora-contracts'
import type { OAuthConfig, OAuthProviderConfig } from '../../../config/auth.config'
import { AUTH_CALLBACK_PATH, AUTH_PROVIDER, SERVER_PATH } from '@haohaoxue/lexora-contracts'
import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AuthProvider } from '@prisma/client'
import * as client from 'openid-client'

/**
 * OAuth 提供商运行时配置。
 */
export interface OAuthRuntimeProvider {
  name: AuthProviderName
  dbProvider: AuthProvider
  config: client.Configuration
  userinfoEndpoint: string
  scopes: string
}

const OAUTH_PROVIDER_CONFIG_KEY = {
  [AUTH_PROVIDER.GOOGLE]: 'google',
  [AUTH_PROVIDER.GITHUB]: 'github',
  [AUTH_PROVIDER.LINUX_DO]: 'linuxDo',
} as const satisfies Record<AuthProviderName, keyof Pick<OAuthConfig, 'github' | 'linuxDo' | 'google'>>

const OAUTH_PROVIDER_DB_PROVIDER = {
  [AUTH_PROVIDER.GOOGLE]: AuthProvider.GOOGLE,
  [AUTH_PROVIDER.GITHUB]: AuthProvider.GITHUB,
  [AUTH_PROVIDER.LINUX_DO]: AuthProvider.LINUX_DO,
} as const satisfies Record<AuthProviderName, AuthProvider>

@Injectable()
export class OAuthProviderService {
  private readonly providerCache = new Map<AuthProviderName, Promise<OAuthRuntimeProvider>>()
  constructor(private readonly configService: ConfigService) {}

  async getProvider(provider: AuthProviderName): Promise<OAuthRuntimeProvider> {
    const cached = this.providerCache.get(provider)
    if (cached) {
      return cached
    }

    const oauthConfig = this.configService.getOrThrow<OAuthConfig>('oauth')

    const result = this.buildProvider(
      provider,
      OAUTH_PROVIDER_DB_PROVIDER[provider],
      oauthConfig[OAUTH_PROVIDER_CONFIG_KEY[provider]],
    )

    this.providerCache.set(provider, result)

    try {
      return await result
    }
    catch (error) {
      this.providerCache.delete(provider)
      throw error
    }
  }

  resolveWebCallbackUrl(webOrigin: string): string {
    return new URL(AUTH_CALLBACK_PATH, this.normalizeOrigin(webOrigin)).toString()
  }

  resolveApiCallbackUrl(provider: AuthProviderName, webOrigin: string): string {
    return new URL(`${SERVER_PATH}/auth/oauth/${provider}/callback`, this.normalizeOrigin(webOrigin)).toString()
  }

  private async buildProvider(
    name: AuthProviderName,
    dbProvider: AuthProvider,
    providerConfig: OAuthProviderConfig,
  ): Promise<OAuthRuntimeProvider> {
    if (!providerConfig.clientId || !providerConfig.clientSecret) {
      throw new BadRequestException(`${name} OAuth provider is not configured`)
    }

    const configuration = await this.createConfiguration(name, providerConfig)
    const userinfoEndpoint = configuration.serverMetadata().userinfo_endpoint ?? providerConfig.userinfoEndpoint

    if (!userinfoEndpoint) {
      throw new BadRequestException(`${name} OAuth provider is not configured`)
    }

    return {
      name,
      dbProvider,
      config: configuration,
      userinfoEndpoint,
      scopes: providerConfig.scopes,
    }
  }

  private async createConfiguration(
    name: AuthProviderName,
    providerConfig: OAuthProviderConfig,
  ): Promise<client.Configuration> {
    try {
      if (
        !providerConfig.authorizationEndpoint
        || !providerConfig.tokenEndpoint
        || !providerConfig.userinfoEndpoint
      ) {
        throw new BadRequestException(`${name} OAuth provider is not configured`)
      }

      const issuer = providerConfig.issuer ?? new URL('/', providerConfig.authorizationEndpoint).href
      const serverMetadata: client.ServerMetadata = {
        issuer,
        authorization_endpoint: providerConfig.authorizationEndpoint,
        token_endpoint: providerConfig.tokenEndpoint,
        userinfo_endpoint: providerConfig.userinfoEndpoint,
        jwks_uri: providerConfig.jwksEndpoint,
      }

      return new client.Configuration(
        serverMetadata,
        providerConfig.clientId!,
        providerConfig.clientSecret!,
      )
    }
    catch (error) {
      if (error instanceof BadRequestException) {
        throw error
      }

      throw new InternalServerErrorException(`Failed to initialize ${name} OAuth provider`)
    }
  }

  private normalizeOrigin(rawWebOrigin: string): string {
    const normalizedValue = rawWebOrigin.trim().replace(/\/+$/g, '')
    let url: URL

    try {
      url = new URL(normalizedValue)
    }
    catch {
      throw new BadRequestException('Invalid web origin')
    }

    if (
      url.origin !== normalizedValue
      || url.pathname !== '/'
      || url.search.length
      || url.hash.length
      || url.username.length
      || url.password.length
    ) {
      throw new BadRequestException('Invalid web origin')
    }

    return url.origin
  }
}
