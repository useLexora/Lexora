import type { SessionUser } from '@haohaoxue/lexora-contracts'
import type { FastifyRequest } from 'fastify'
import type { JwtConfig } from '../../config/auth.config'
import type {
  AccessTokenPayload,
  AuthUserContext,
  TokenExchangeResult,
} from './auth.interface'
import { Buffer } from 'node:buffer'
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto'
import { AUTH_ERROR_CODE } from '@haohaoxue/lexora-contracts'
import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { UserStatus } from '@prisma/client'
import { parse, serialize } from 'cookie'
import { SignJWT } from 'jose'
import { PrismaService } from '../../database/prisma.service'
import { sha256Hex } from '../../utils/hash'
import { RbacService } from '../rbac/rbac.service'
import { resolveAuthMethods } from './auth-methods.utils'
import {
  LOGIN_CODE_TTL_SECONDS,
  REFRESH_TOKEN_COOKIE_NAME,
} from './auth.constants'
import { authUnauthorized } from './auth.utils'

@Injectable()
export class AuthSessionsService {
  private readonly jwtConfig
  private readonly accessSecretKey
  private readonly isProduction

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly rbacService: RbacService,
  ) {
    this.jwtConfig = this.configService.getOrThrow<JwtConfig>('jwt')
    this.accessSecretKey = createSecretKey(Buffer.from(this.jwtConfig.accessSecret, 'utf8'))
    this.isProduction = this.configService.getOrThrow<boolean>('server.isProduction')
  }

  async issueAuthSession(
    userId: string,
    request: FastifyRequest,
  ): Promise<TokenExchangeResult> {
    await this.rbacService.syncBootstrapRolesForUser(userId)
    const authUser = await this.buildAuthUserContext(userId)
    await this.touchUserLastLogin(userId)
    const accessToken = await this.signAccessToken(authUser)
    const session = await this.createRefreshSession(userId, request)

    return this.buildTokenExchangeResult(userId, authUser, accessToken, session.rawToken)
  }

  async createLoginCode(userId: string, redirectUri: string): Promise<string> {
    const loginCode = randomBytes(32).toString('base64url')

    await this.prisma.authLoginCode.create({
      data: {
        userId,
        codeHash: this.hash(loginCode),
        redirectUri,
        expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_SECONDS * 1000),
      },
    })

    return loginCode
  }

  async exchangeCodeForTokens(
    rawCode: string,
    request: FastifyRequest,
  ): Promise<TokenExchangeResult> {
    const loginCode = await this.prisma.authLoginCode.findUnique({
      where: { codeHash: this.hash(rawCode) },
      include: {
        user: true,
      },
    })

    if (!loginCode) {
      throw new UnauthorizedException('Invalid login code')
    }

    if (loginCode.consumedAt || loginCode.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Login code expired or consumed')
    }

    const consumed = await this.prisma.authLoginCode.updateMany({
      where: {
        id: loginCode.id,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    })

    if (consumed.count !== 1) {
      throw new UnauthorizedException('Login code already consumed')
    }

    return this.issueAuthSession(loginCode.user.id, request)
  }

  async refreshTokens(request: FastifyRequest): Promise<TokenExchangeResult> {
    const refreshToken = this.extractRefreshTokenFromCookie(request)

    if (!refreshToken) {
      throw authUnauthorized(AUTH_ERROR_CODE.REFRESH_TOKEN_MISSING, '刷新凭证不存在')
    }

    const tokenRecord = await this.prisma.authRefreshToken.findUnique({
      where: { tokenHash: this.hash(refreshToken) },
      include: {
        user: true,
      },
    })

    if (!tokenRecord || tokenRecord.revokedAt || tokenRecord.expiresAt.getTime() <= Date.now()) {
      throw authUnauthorized(AUTH_ERROR_CODE.REFRESH_TOKEN_INVALID, '登录状态已失效')
    }

    const rotatedSession = await this.rotateRefreshSession(tokenRecord, request)
    await this.rbacService.syncBootstrapRolesForUser(tokenRecord.user.id)
    const authUser = await this.buildAuthUserContext(tokenRecord.user.id)
    await this.touchUserLastLogin(tokenRecord.user.id)
    const accessToken = await this.signAccessToken(authUser)

    return this.buildTokenExchangeResult(tokenRecord.user.id, authUser, accessToken, rotatedSession.rawToken)
  }

  async logout(request: FastifyRequest): Promise<{ clearCookie: string }> {
    const refreshToken = this.extractRefreshTokenFromCookie(request)

    if (refreshToken) {
      await this.prisma.authRefreshToken.updateMany({
        where: {
          tokenHash: this.hash(refreshToken),
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      })
    }

    return {
      clearCookie: this.clearRefreshCookie(),
    }
  }

  buildLogoutCookieHeader(): string {
    return this.clearRefreshCookie()
  }

  private async buildAuthUserContext(userId: string): Promise<AuthUserContext> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        status: true,
      },
    })

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw authUnauthorized(AUTH_ERROR_CODE.SESSION_USER_INACTIVE, '当前账号不可用')
    }

    const roleAndPermissions = await this.rbacService.getUserRoleAndPermissions(userId)

    return {
      id: userId,
      roles: roleAndPermissions.roles,
      permissions: roleAndPermissions.permissions,
    }
  }

  private async buildSessionUser(
    userId: string,
    authUser: AuthUserContext,
  ): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        userCode: true,
        localCredential: {
          select: {
            mustChangePassword: true,
            emailVerifiedAt: true,
          },
        },
        oauthAccounts: {
          where: {
            deletedAt: null,
          },
          select: {
            provider: true,
            providerEmailVerified: true,
          },
        },
      },
    })

    if (!user) {
      throw authUnauthorized(AUTH_ERROR_CODE.SESSION_USER_INACTIVE, '当前账号不可用')
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      userCode: user.userCode,
      roles: authUser.roles,
      permissions: authUser.permissions,
      authMethods: resolveAuthMethods(Boolean(user.localCredential), user.oauthAccounts),
      mustChangePassword: user.localCredential?.mustChangePassword ?? false,
      emailVerified: Boolean(user.localCredential?.emailVerifiedAt) || user.oauthAccounts.some(item => item.providerEmailVerified === true),
    }
  }

  private async touchUserLastLogin(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        lastLoginAt: new Date(),
      },
    })
  }

  private async signAccessToken(authUser: AuthUserContext): Promise<string> {
    const payload: AccessTokenPayload = {
      tokenType: 'access',
      roles: authUser.roles,
      permissions: authUser.permissions,
    }

    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(authUser.id)
      .setIssuer(this.jwtConfig.issuer)
      .setAudience(this.jwtConfig.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.jwtConfig.accessTtlSeconds}s`)
      .setJti(randomUUID())
      .sign(this.accessSecretKey)
  }

  private async createRefreshSession(
    userId: string,
    request: FastifyRequest,
    familyId = randomUUID(),
  ): Promise<{ rawToken: string, tokenId: string, familyId: string }> {
    const tokenId = randomUUID()
    const rawToken = this.generateRefreshToken()
    const tokenHash = this.hash(rawToken)

    await this.prisma.authRefreshToken.create({
      data: {
        id: tokenId,
        userId,
        tokenHash,
        familyId,
        expiresAt: new Date(Date.now() + this.jwtConfig.refreshTtlSeconds * 1000),
        createdIp: this.extractRequestIp(request),
        userAgent: request.headers['user-agent'],
      },
    })

    return { rawToken, tokenId, familyId }
  }

  private async rotateRefreshSession(
    tokenRecord: {
      id: string
      userId: string
      familyId: string
    },
    request: FastifyRequest,
  ): Promise<{ rawToken: string }> {
    return this.prisma.$transaction(async (tx) => {
      const tokenId = randomUUID()
      const rawToken = this.generateRefreshToken()
      const tokenHash = this.hash(rawToken)

      await tx.authRefreshToken.create({
        data: {
          id: tokenId,
          userId: tokenRecord.userId,
          familyId: tokenRecord.familyId,
          tokenHash,
          expiresAt: new Date(Date.now() + this.jwtConfig.refreshTtlSeconds * 1000),
          createdIp: this.extractRequestIp(request),
          userAgent: request.headers['user-agent'],
        },
      })

      const updated = await tx.authRefreshToken.updateMany({
        where: {
          id: tokenRecord.id,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          replacedById: tokenId,
        },
      })

      if (updated.count !== 1) {
        throw new UnauthorizedException('Refresh token already rotated')
      }

      return { rawToken }
    })
  }

  private async buildTokenExchangeResult(
    userId: string,
    authUser: AuthUserContext,
    accessToken: string,
    rawRefreshToken: string,
  ): Promise<TokenExchangeResult> {
    return {
      accessToken,
      expiresIn: this.jwtConfig.accessTtlSeconds,
      user: await this.buildSessionUser(userId, authUser),
      refreshTokenCookie: this.buildRefreshCookie(rawRefreshToken),
    }
  }

  private get refreshCookieOptions() {
    return {
      path: '/api/auth',
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.isProduction,
    }
  }

  private buildRefreshCookie(refreshToken: string): string {
    return serialize(REFRESH_TOKEN_COOKIE_NAME, refreshToken, {
      ...this.refreshCookieOptions,
      maxAge: this.jwtConfig.refreshTtlSeconds,
    })
  }

  private clearRefreshCookie(): string {
    return serialize(REFRESH_TOKEN_COOKIE_NAME, '', {
      ...this.refreshCookieOptions,
      maxAge: 0,
    })
  }

  private extractRefreshTokenFromCookie(request: FastifyRequest): string | undefined {
    const cookieHeader = request.headers.cookie

    if (!cookieHeader) {
      return undefined
    }

    return parse(cookieHeader)[REFRESH_TOKEN_COOKIE_NAME]
  }

  private hash(value: string): string {
    return sha256Hex(value)
  }

  private generateRefreshToken(): string {
    return randomBytes(32).toString('base64url')
  }

  private extractRequestIp(request: FastifyRequest): string | undefined {
    const forwardedFor = request.headers['x-forwarded-for']

    if (Array.isArray(forwardedFor)) {
      return forwardedFor[0]?.split(',').map(part => part.trim()).filter(Boolean)[0]
    }

    if (typeof forwardedFor === 'string') {
      return forwardedFor.split(',').map(part => part.trim()).filter(Boolean)[0]
    }

    return request.ip
  }
}
