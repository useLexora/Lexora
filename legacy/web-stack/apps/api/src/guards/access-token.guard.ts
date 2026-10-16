import type { CanActivate, ExecutionContext } from '@nestjs/common'
import type { JwtConfig } from '../config/auth.config'
import type { AccessTokenPayload, AuthUserContext } from '../modules/auth/auth.interface'
import { Buffer } from 'node:buffer'
import { createSecretKey } from 'node:crypto'
import { AUTH_ERROR_CODE } from '@haohaoxue/lexora-contracts'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { UserStatus } from '@prisma/client'
import { jwtVerify } from 'jose'
import { PrismaService } from '../database/prisma.service'
import { IS_PUBLIC_KEY } from '../decorators/public.decorator'
import { authUnauthorized } from '../modules/auth/auth.utils'
import { RbacService } from '../modules/rbac/rbac.service'

@Injectable()
export class AccessTokenGuard implements CanActivate {
  private readonly secretKey
  private readonly jwtConfig

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly rbacService: RbacService,
  ) {
    this.jwtConfig = this.configService.getOrThrow<JwtConfig>('jwt')
    this.secretKey = createSecretKey(Buffer.from(this.jwtConfig.accessSecret, 'utf8'))
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>
      authUser?: AuthUserContext
    }>()

    if (isPublic) {
      try {
        await this.authenticateRequest(request)
      }
      catch {
      }
      return true
    }

    await this.authenticateRequest(request)

    return true
  }

  private async authenticateRequest(request: {
    headers: Record<string, string | undefined>
    authUser?: AuthUserContext
  }) {
    const authorizationHeader = request.headers.authorization

    if (!authorizationHeader?.startsWith('Bearer ')) {
      throw authUnauthorized(AUTH_ERROR_CODE.ACCESS_TOKEN_MISSING, '缺少访问凭证')
    }

    const accessToken = authorizationHeader.slice('Bearer '.length).trim()

    if (!accessToken) {
      throw authUnauthorized(AUTH_ERROR_CODE.ACCESS_TOKEN_INVALID, '访问凭证无效')
    }

    const payload = await this.verifyToken(accessToken)

    if (payload.tokenType !== 'access' || !payload.sub) {
      throw authUnauthorized(AUTH_ERROR_CODE.ACCESS_TOKEN_INVALID, '访问凭证无效')
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        status: true,
        localCredential: {
          select: {
            passwordUpdatedAt: true,
          },
        },
      },
    })

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw authUnauthorized(AUTH_ERROR_CODE.SESSION_USER_INACTIVE, '当前账号不可用')
    }

    if (isAccessTokenStale(payload, user.localCredential?.passwordUpdatedAt)) {
      throw authUnauthorized(AUTH_ERROR_CODE.ACCESS_TOKEN_INVALID, '登录状态已失效')
    }

    await this.rbacService.syncBootstrapRolesForUser(user.id)
    const roleContext = await this.rbacService.getUserRoleAndPermissions(user.id)

    request.authUser = {
      id: user.id,
      roles: roleContext.roles,
      permissions: roleContext.permissions,
    }
  }

  private async verifyToken(token: string): Promise<AccessTokenPayload & { sub?: string }> {
    try {
      const { payload } = await jwtVerify<AccessTokenPayload>(
        token,
        this.secretKey,
        {
          issuer: this.jwtConfig.issuer,
          audience: this.jwtConfig.audience,
        },
      )
      return payload
    }
    catch (error) {
      if (error instanceof Error && error.name === 'JWTExpired') {
        throw authUnauthorized(AUTH_ERROR_CODE.ACCESS_TOKEN_EXPIRED, '登录状态已过期')
      }

      throw authUnauthorized(AUTH_ERROR_CODE.ACCESS_TOKEN_INVALID, '访问凭证校验失败')
    }
  }
}

function isAccessTokenStale(
  payload: AccessTokenPayload,
  passwordUpdatedAt: Date | null | undefined,
): boolean {
  if (!passwordUpdatedAt) {
    return false
  }

  if (typeof payload.iat !== 'number') {
    return true
  }

  return payload.iat < Math.floor(passwordUpdatedAt.getTime() / 1000)
}
