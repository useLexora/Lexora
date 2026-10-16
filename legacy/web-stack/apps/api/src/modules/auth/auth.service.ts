import type { AuthProviderName } from '@haohaoxue/lexora-contracts'
import type { Prisma, User } from '@prisma/client'
import type { FastifyRequest } from 'fastify'
import type {
  BuildOAuthAuthorizationUrlOptions,
  OAuthProfile,
  OAuthStatePayload,
  TokenExchangeResult,
} from './auth.interface'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  AUTH_PROVIDER,
  OAUTH_REDIRECT_BIND_STATUS,
  OAUTH_REDIRECT_ERROR_CODE,
  OAUTH_REDIRECT_QUERY,
} from '@haohaoxue/lexora-contracts'
import { formatAuthMethod } from '@haohaoxue/lexora-shared'
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import { AuthProvider, UserStatus } from '@prisma/client'
import * as client from 'openid-client'
import { PrismaService } from '../../database/prisma.service'
import { normalizeEmail } from '../../utils/email'
import { resolveUniqueUserCode } from '../users/users.utils'
import { PersonalWorkspacesService } from '../workspaces/personal-workspaces.service'
import { resolveAuthMethod } from './auth-methods.utils'
import { AuthSessionsService } from './auth-sessions.service'
import {
  OAUTH_FETCH_RETRY_DELAYS_MS,
  OAUTH_LOGIN_REDIRECT_PATH,
  OAUTH_STATE_TTL_SECONDS,
  OAUTH_STATE_VERSION,
  RETRYABLE_OAUTH_FETCH_ERROR_RE,
} from './auth.constants'
import { buildOauthAccountData } from './auth.utils'
import { hashPassword, verifyPassword } from './password.utils'
import { OAuthProviderService } from './providers/oauth-provider.service'
import { RegistrationInviteGrantsService } from './registration-invite-grants.service'
import { SystemAuthService } from './system-auth.service'

type OAuthRedirectErrorCode = (typeof OAUTH_REDIRECT_ERROR_CODE)[keyof typeof OAUTH_REDIRECT_ERROR_CODE]

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly oauthProviderService: OAuthProviderService,
    private readonly systemAuthService: SystemAuthService,
    private readonly personalWorkspacesService: PersonalWorkspacesService,
    private readonly authSessionsService: AuthSessionsService,
    private readonly registrationInviteGrantsService: RegistrationInviteGrantsService,
  ) {}

  async loginWithPassword(
    email: string,
    password: string,
    request: FastifyRequest,
  ): Promise<TokenExchangeResult> {
    const normalizedEmail = normalizeEmail(email)
    const credential = await this.prisma.localCredential.findFirst({
      where: {
        user: {
          email: normalizedEmail,
        },
      },
      select: {
        passwordHash: true,
        emailVerifiedAt: true,
        user: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    })

    if (!credential) {
      throw new UnauthorizedException('邮箱或密码错误')
    }

    if (credential.user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('User is inactive')
    }

    if (!credential.emailVerifiedAt) {
      throw new UnauthorizedException('邮箱尚未完成验证')
    }

    const isPasswordValid = await verifyPassword(password, credential.passwordHash)

    if (!isPasswordValid) {
      throw new UnauthorizedException('邮箱或密码错误')
    }

    return this.authSessionsService.issueAuthSession(credential.user.id, request)
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    request: FastifyRequest,
  ): Promise<TokenExchangeResult> {
    if (currentPassword === newPassword) {
      throw new BadRequestException('新密码不能与当前密码相同')
    }

    const credential = await this.prisma.localCredential.findUnique({
      where: { userId },
      select: {
        passwordHash: true,
      },
    })

    if (!credential) {
      throw new BadRequestException('当前账号未启用邮箱密码登录')
    }

    const isPasswordValid = await verifyPassword(currentPassword, credential.passwordHash)

    if (!isPasswordValid) {
      throw new UnauthorizedException('当前密码错误')
    }

    const passwordHash = await hashPassword(newPassword)

    await this.prisma.$transaction(async (tx) => {
      await tx.localCredential.update({
        where: { userId },
        data: {
          passwordHash,
          mustChangePassword: false,
          emailVerifiedAt: new Date(),
          passwordUpdatedAt: new Date(),
        },
      })

      await tx.authRefreshToken.updateMany({
        where: {
          userId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      })
    })

    return this.authSessionsService.issueAuthSession(userId, request)
  }

  async buildOAuthBindingAuthorizationUrl(
    userId: string,
    provider: AuthProviderName,
    request: FastifyRequest,
    redirectPath: string,
  ): Promise<string> {
    return this.buildOAuthAuthorizationUrl(provider, request, {
      purpose: 'bind',
      initiatorUserId: userId,
      redirectPath,
    })
  }

  async disconnectOauthBinding(
    userId: string,
    provider: AuthProviderName,
  ): Promise<void> {
    const dbProvider = resolveDbAuthProvider(provider)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        localCredential: {
          select: {
            userId: true,
          },
        },
        oauthAccounts: {
          where: {
            deletedAt: null,
          },
          select: {
            id: true,
            provider: true,
          },
        },
      },
    })

    if (!user) {
      throw new NotFoundException(`User "${userId}" not found`)
    }

    const targetAccount = user.oauthAccounts.find(item => item.provider === dbProvider)

    if (!targetAccount) {
      throw new BadRequestException('当前账号未绑定该第三方平台')
    }

    const remainingOauthCount = user.oauthAccounts.length - 1

    if (!user.localCredential && remainingOauthCount <= 0) {
      throw new BadRequestException('解绑后至少需要保留一种登录方式')
    }

    await this.prisma.oauthAccount.delete({
      where: { id: targetAccount.id },
    })
  }

  async buildOAuthAuthorizationUrl(
    provider: AuthProviderName,
    request: FastifyRequest,
    options: BuildOAuthAuthorizationUrlOptions = {},
  ): Promise<string> {
    const runtimeProvider = await this.oauthProviderService.getProvider(provider)
    const authMethod = resolveAuthMethod(runtimeProvider.dbProvider)
    const webOrigin = this.resolveCurrentUrl(request).origin
    const callbackUrl = this.oauthProviderService.resolveApiCallbackUrl(provider, webOrigin)
    const purpose = options.purpose ?? 'login'
    const redirectPath = options.redirectPath ?? OAUTH_LOGIN_REDIRECT_PATH

    await this.systemAuthService.assertOauthProviderLoginAllowed(authMethod)

    const registrationInviteGrant = options.registrationInviteGrantToken
      ? await this.registrationInviteGrantsService.assertGrantReady({
          method: authMethod,
          provider: runtimeProvider.dbProvider,
          grantToken: options.registrationInviteGrantToken,
        })
      : null

    const state = this.createOAuthState({
      webOrigin,
      purpose,
      redirectPath,
    })
    const codeVerifier = client.randomPKCECodeVerifier()
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)

    await this.prisma.authOauthState.create({
      data: {
        provider: runtimeProvider.dbProvider,
        purpose: purpose === 'bind' ? 'BIND' : 'LOGIN',
        initiatorUserId: purpose === 'bind' ? options.initiatorUserId ?? null : null,
        registrationInviteGrantId: registrationInviteGrant?.id ?? null,
        state,
        codeVerifier,
        redirectUri: callbackUrl,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_SECONDS * 1000),
      },
    })

    const authorizationUrl = client.buildAuthorizationUrl(runtimeProvider.config, {
      response_type: 'code',
      redirect_uri: callbackUrl,
      scope: runtimeProvider.scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    return authorizationUrl.toString()
  }

  async handleOAuthCallback(provider: AuthProviderName, request: FastifyRequest): Promise<string> {
    const runtimeProvider = await this.oauthProviderService.getProvider(provider)
    const authMethod = resolveAuthMethod(runtimeProvider.dbProvider)
    const currentUrl = this.resolveCurrentUrl(request)
    const state = currentUrl.searchParams.get('state')

    await this.systemAuthService.assertOauthProviderLoginAllowed(authMethod)

    if (!state) {
      throw new UnauthorizedException('Missing OAuth state')
    }

    const oauthState = await this.prisma.authOauthState.findUnique({
      where: { state },
    })

    if (!oauthState || oauthState.provider !== runtimeProvider.dbProvider) {
      throw new UnauthorizedException('OAuth state is invalid')
    }

    if (oauthState.consumedAt || oauthState.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('OAuth state expired')
    }

    const tokens = await client.authorizationCodeGrant(
      runtimeProvider.config,
      currentUrl,
      {
        expectedState: state,
        pkceCodeVerifier: oauthState.codeVerifier,
      },
      {
        redirect_uri: oauthState.redirectUri,
      },
    )

    const accessToken = tokens.access_token

    if (!accessToken) {
      throw new UnauthorizedException('OAuth token exchange failed')
    }

    const statePayload = this.extractOAuthStatePayload(oauthState.state)
    const profile = await this.fetchOAuthProfile(provider, accessToken, runtimeProvider.userinfoEndpoint)

    await this.prisma.authOauthState.update({
      where: { id: oauthState.id },
      data: { consumedAt: new Date() },
    })

    if (oauthState.purpose === 'BIND') {
      if (!oauthState.initiatorUserId) {
        throw new UnauthorizedException('OAuth bind state is invalid')
      }

      await this.bindOAuthToUser(runtimeProvider.dbProvider, profile, oauthState.initiatorUserId)

      const redirectUrl = new URL(statePayload.redirectPath, statePayload.webOrigin)
      redirectUrl.searchParams.set(OAUTH_REDIRECT_QUERY.BIND_STATUS, OAUTH_REDIRECT_BIND_STATUS.SUCCESS)
      redirectUrl.searchParams.set(OAUTH_REDIRECT_QUERY.PROVIDER, provider)
      return redirectUrl.toString()
    }

    const user = await this.upsertUserByOAuth(
      runtimeProvider.dbProvider,
      profile,
      oauthState.registrationInviteGrantId,
    )

    const webCallbackUrl = new URL(statePayload.redirectPath, statePayload.webOrigin).toString()
    const loginCode = await this.authSessionsService.createLoginCode(user.id, webCallbackUrl)
    const redirectUrl = new URL(webCallbackUrl)
    redirectUrl.searchParams.set(OAUTH_REDIRECT_QUERY.LOGIN_CODE, loginCode)

    return redirectUrl.toString()
  }

  buildOAuthFailureRedirect(
    provider: AuthProviderName,
    request: FastifyRequest,
    errorCode: OAuthRedirectErrorCode,
  ): string {
    const state = this.resolveCurrentUrl(request).searchParams.get('state')

    if (!state) {
      return `${OAUTH_LOGIN_REDIRECT_PATH}?${OAUTH_REDIRECT_QUERY.ERROR_CODE}=${encodeURIComponent(errorCode)}`
    }

    try {
      const payload = this.extractOAuthStatePayload(state)
      const redirectUrl = new URL(payload.redirectPath, payload.webOrigin)

      if (payload.purpose === 'bind') {
        redirectUrl.searchParams.set(OAUTH_REDIRECT_QUERY.BIND_STATUS, OAUTH_REDIRECT_BIND_STATUS.ERROR)
        redirectUrl.searchParams.set(OAUTH_REDIRECT_QUERY.PROVIDER, provider)
        redirectUrl.searchParams.set(OAUTH_REDIRECT_QUERY.BIND_ERROR_CODE, errorCode)
        return redirectUrl.toString()
      }

      redirectUrl.searchParams.set(OAUTH_REDIRECT_QUERY.ERROR_CODE, errorCode)
      return redirectUrl.toString()
    }
    catch {
      return `${OAUTH_LOGIN_REDIRECT_PATH}?${OAUTH_REDIRECT_QUERY.ERROR_CODE}=${encodeURIComponent(errorCode)}`
    }
  }

  private createOAuthState(input: {
    webOrigin: string
    purpose: 'login' | 'bind'
    redirectPath: string
  }): string {
    return Buffer.from(JSON.stringify({
      v: OAUTH_STATE_VERSION,
      nonce: client.randomState(),
      webOrigin: input.webOrigin,
      purpose: input.purpose,
      redirectPath: input.redirectPath,
    }), 'utf8').toString('base64url')
  }

  private extractOAuthStatePayload(state: string): OAuthStatePayload {
    try {
      const payload = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as Partial<OAuthStatePayload>

      if (
        payload.v !== OAUTH_STATE_VERSION
        || typeof payload.webOrigin !== 'string'
        || (payload.purpose !== 'login' && payload.purpose !== 'bind')
        || typeof payload.redirectPath !== 'string'
      ) {
        throw new Error('Invalid OAuth state payload')
      }

      return payload as OAuthStatePayload
    }
    catch {
      throw new UnauthorizedException('OAuth state is invalid')
    }
  }

  private async upsertUserByOAuth(
    provider: AuthProvider,
    profile: OAuthProfile,
    registrationInviteGrantId: string | null,
  ): Promise<User> {
    const existingAccount = await this.prisma.$bypass.oauthAccount.findUnique({
      where: {
        provider_providerUserId: {
          provider,
          providerUserId: profile.providerUserId,
        },
      },
      include: { user: true },
    })

    if (existingAccount) {
      await this.prisma.$bypass.oauthAccount.update({
        where: { id: existingAccount.id },
        data: {
          ...buildOauthAccountData(profile),
          deletedAt: null,
        },
      })

      if (!existingAccount.user.avatarUrl && profile.avatarUrl) {
        const updatedUser = await this.prisma.user.update({
          where: { id: existingAccount.user.id },
          data: {
            avatarUrl: profile.avatarUrl,
          },
        })

        await this.personalWorkspacesService.provisionPersonalWorkspaceForUser({
          userId: updatedUser.id,
          userCode: updatedUser.userCode,
        })

        return updatedUser
      }

      await this.personalWorkspacesService.provisionPersonalWorkspaceForUser({
        userId: existingAccount.user.id,
        userCode: existingAccount.user.userCode,
      })

      return existingAccount.user
    }

    await this.systemAuthService.assertRegistrationAllowed(resolveAuthMethod(provider))

    const user = await this.prisma.$transaction(async (tx) => {
      await this.registrationInviteGrantsService.consumeGrantById({
        method: resolveAuthMethod(provider),
        provider,
        grantId: registrationInviteGrantId,
      }, tx)

      const userCode = await resolveUniqueUserCode({
        isUserCodeTaken: async candidate =>
          Boolean(await tx.user.findUnique({
            where: { userCode: candidate },
            select: { id: true },
          })),
      })

      const targetUser = await tx.user.create({
        data: {
          displayName: profile.displayName ?? profile.username ?? `user-${randomUUID().slice(0, 8)}`,
          avatarUrl: profile.avatarUrl,
          userCode,
        },
      })

      await this.personalWorkspacesService.provisionPersonalWorkspaceForUser({
        userId: targetUser.id,
        userCode: targetUser.userCode,
      }, tx)

      await tx.oauthAccount.create({
        data: {
          userId: targetUser.id,
          provider,
          providerUserId: profile.providerUserId,
          providerUsername: profile.username,
          providerEmail: null,
          providerEmailVerified: false,
          rawProfile: profile.rawProfile as Prisma.InputJsonValue,
        },
      })

      return targetUser
    })

    return user
  }

  private async bindOAuthToUser(
    provider: AuthProvider,
    profile: OAuthProfile,
    userId: string,
  ): Promise<void> {
    const [targetUser, existingProviderBinding, existingCurrentProviderAccount] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          avatarUrl: true,
        },
      }),
      this.prisma.$bypass.oauthAccount.findUnique({
        where: {
          provider_providerUserId: {
            provider,
            providerUserId: profile.providerUserId,
          },
        },
      }),
      this.prisma.oauthAccount.findFirst({
        where: {
          userId,
          provider,
        },
      }),
    ])

    if (!targetUser) {
      throw new BadRequestException('当前账号不存在或已失效')
    }

    if (existingProviderBinding && !existingProviderBinding.deletedAt && existingProviderBinding.userId !== userId) {
      throw new BadRequestException(`该${formatAuthMethod(resolveAuthMethod(provider))}账号已绑定到其他账号`)
    }

    if (
      existingCurrentProviderAccount
      && existingCurrentProviderAccount.providerUserId !== profile.providerUserId
    ) {
      throw new BadRequestException(`当前账号已绑定其他${formatAuthMethod(resolveAuthMethod(provider))}账号`)
    }

    if (existingProviderBinding) {
      await this.prisma.$bypass.oauthAccount.update({
        where: { id: existingProviderBinding.id },
        data: {
          userId,
          ...buildOauthAccountData(profile),
          deletedAt: null,
        },
      })

      if (!targetUser.avatarUrl && profile.avatarUrl) {
        await this.prisma.user.update({
          where: { id: userId },
          data: {
            avatarUrl: profile.avatarUrl,
          },
        })
      }

      return
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.oauthAccount.create({
        data: {
          userId,
          provider,
          providerUserId: profile.providerUserId,
          ...buildOauthAccountData(profile),
        },
      })

      if (!targetUser.avatarUrl && profile.avatarUrl) {
        await tx.user.update({
          where: { id: userId },
          data: {
            avatarUrl: profile.avatarUrl,
          },
        })
      }
    })
  }

  private async fetchOAuthProfile(
    provider: AuthProviderName,
    accessToken: string,
    userinfoEndpoint: string,
  ): Promise<OAuthProfile> {
    if (provider === AUTH_PROVIDER.GOOGLE) {
      return this.fetchGoogleProfile(accessToken, userinfoEndpoint)
    }

    if (provider === AUTH_PROVIDER.GITHUB) {
      return this.fetchGithubProfile(accessToken, userinfoEndpoint)
    }

    return this.fetchLinuxDoProfile(accessToken, userinfoEndpoint)
  }

  private async fetchGithubProfile(accessToken: string, userinfoEndpoint: string): Promise<OAuthProfile> {
    const userResponse = await this.fetchOAuthResource(userinfoEndpoint, {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'lexora-api',
      'X-GitHub-Api-Version': '2022-11-28',
    })

    if (!userResponse.ok) {
      throw new UnauthorizedException('Failed to fetch GitHub user profile')
    }

    const profile = await userResponse.json() as Record<string, unknown>
    const id = profile.id

    if (!id) {
      throw new UnauthorizedException('GitHub user id is missing')
    }

    return {
      providerUserId: String(id),
      username: typeof profile.login === 'string' ? profile.login : undefined,
      displayName: typeof profile.name === 'string' ? profile.name : undefined,
      email: undefined,
      emailVerified: false,
      avatarUrl: typeof profile.avatar_url === 'string' ? profile.avatar_url : undefined,
      rawProfile: profile,
    }
  }

  private async fetchLinuxDoProfile(accessToken: string, userinfoEndpoint: string): Promise<OAuthProfile> {
    const response = await this.fetchOAuthResource(userinfoEndpoint, {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    })

    if (!response.ok) {
      throw new UnauthorizedException('Failed to fetch Linux.do user profile')
    }

    const profile = await response.json() as Record<string, unknown>
    const providerUserId
      = (typeof profile.sub === 'string' && profile.sub)
        || (typeof profile.id === 'string' && profile.id)
        || (typeof profile.id === 'number' && String(profile.id))

    if (!providerUserId) {
      throw new UnauthorizedException('Linux.do user id is missing')
    }

    return {
      providerUserId,
      username:
        (typeof profile.preferred_username === 'string' && profile.preferred_username)
        || (typeof profile.username === 'string' && profile.username)
        || (typeof profile.login === 'string' && profile.login)
        || undefined,
      displayName:
        (typeof profile.name === 'string' && profile.name)
        || (typeof profile.nickname === 'string' && profile.nickname)
        || undefined,
      email: undefined,
      emailVerified: false,
      avatarUrl:
        (typeof profile.picture === 'string' && profile.picture)
        || (typeof profile.avatar_url === 'string' && profile.avatar_url)
        || undefined,
      rawProfile: profile,
    }
  }

  private async fetchGoogleProfile(accessToken: string, userinfoEndpoint: string): Promise<OAuthProfile> {
    const response = await this.fetchOAuthResource(userinfoEndpoint, {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    })

    if (!response.ok) {
      throw new UnauthorizedException('Failed to fetch Google user profile')
    }

    const profile = await response.json() as Record<string, unknown>
    const providerUserId = typeof profile.sub === 'string' ? profile.sub : null

    if (!providerUserId) {
      throw new UnauthorizedException('Google user id is missing')
    }

    return {
      providerUserId,
      username: typeof profile.email === 'string' ? profile.email : undefined,
      displayName: typeof profile.name === 'string' ? profile.name : undefined,
      email: undefined,
      emailVerified: false,
      avatarUrl: typeof profile.picture === 'string' ? profile.picture : undefined,
      rawProfile: profile,
    }
  }

  private async fetchOAuthResource(url: string, headers: Record<string, string>): Promise<Response> {
    let lastError: unknown

    for (const retryDelayMs of [...OAUTH_FETCH_RETRY_DELAYS_MS, null]) {
      try {
        return await fetch(url, { headers })
      }
      catch (error) {
        lastError = error

        if (!this.isRetryableOAuthFetchError(error) || retryDelayMs === null) {
          throw error
        }

        await delay(retryDelayMs)
      }
    }

    throw lastError
  }

  private isRetryableOAuthFetchError(error: unknown): boolean {
    if (!(error instanceof TypeError)) {
      return false
    }

    const cause = error.cause

    if (cause && typeof cause === 'object' && 'code' in cause) {
      return [
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'EAI_AGAIN',
      ].includes(String(cause.code))
    }

    return RETRYABLE_OAUTH_FETCH_ERROR_RE.test(error.message)
  }

  private resolveCurrentUrl(request: FastifyRequest): URL {
    const host = request.headers['x-forwarded-host'] ?? request.headers.host

    if (!host) {
      throw new BadRequestException('Missing request host')
    }

    const protocolHeader = request.headers['x-forwarded-proto']
    const protocol = Array.isArray(protocolHeader)
      ? protocolHeader[0]
      : (protocolHeader ?? request.protocol ?? 'http')

    return new URL(request.url, `${protocol}://${host}`)
  }
}

function resolveDbAuthProvider(provider: AuthProviderName): AuthProvider {
  if (provider === AUTH_PROVIDER.GOOGLE) {
    return AuthProvider.GOOGLE
  }

  if (provider === AUTH_PROVIDER.GITHUB) {
    return AuthProvider.GITHUB
  }

  if (provider === AUTH_PROVIDER.LINUX_DO) {
    return AuthProvider.LINUX_DO
  }

  return AuthProvider.GOOGLE
}
