import type { AuthMethodName } from '@haohaoxue/lexora-contracts'
import type { Prisma, PrismaClient, RegistrationInviteGrant } from '@prisma/client'
import { randomBytes } from 'node:crypto'
import { AUTH_METHOD, OAUTH_REDIRECT_ERROR_CODE } from '@haohaoxue/lexora-contracts'
import { BadRequestException, Injectable } from '@nestjs/common'
import { AuthProvider } from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { normalizeEmail } from '../../utils/email'
import { sha256Hex } from '../../utils/hash'
import { REGISTRATION_INVITE_GRANT_TTL_SECONDS } from './auth.constants'
import { SystemAuthService } from './system-auth.service'

type RegistrationInviteGrantClient = Pick<PrismaClient, 'registrationInviteGrant'> | Prisma.TransactionClient

export class RegistrationInviteRequiredException extends BadRequestException {
  readonly oauthRedirectErrorCode = OAUTH_REDIRECT_ERROR_CODE.REGISTRATION_INVITE_REQUIRED

  constructor() {
    super('请先验证注册邀请码')
  }
}

@Injectable()
export class RegistrationInviteGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemAuthService: SystemAuthService,
  ) {}

  async createGrant(input: {
    method: AuthMethodName
    email?: string
    inviteCode: string
  }): Promise<{ grantToken: string, expiresAt: Date }> {
    if (input.method !== AUTH_METHOD.PASSWORD) {
      await this.systemAuthService.assertOauthProviderLoginAllowed(input.method)
    }

    await this.systemAuthService.assertRegistrationAllowed(input.method)
    await this.systemAuthService.assertRegistrationInviteCode(input.method, input.inviteCode)

    const grantToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + REGISTRATION_INVITE_GRANT_TTL_SECONDS * 1000)

    await this.prisma.registrationInviteGrant.create({
      data: {
        tokenHash: sha256Hex(grantToken),
        method: input.method,
        normalizedEmail: this.resolveNormalizedEmail(input.method, input.email),
        provider: resolveGrantProvider(input.method),
        expiresAt,
      },
    })

    return {
      grantToken,
      expiresAt,
    }
  }

  async assertGrantReady(input: {
    method: AuthMethodName
    email?: string
    provider?: AuthProvider
    grantToken?: string
  }): Promise<RegistrationInviteGrant | null> {
    if (!(await this.systemAuthService.isRegistrationInviteCodeRequired(input.method))) {
      return null
    }

    if (!input.grantToken) {
      throw new RegistrationInviteRequiredException()
    }

    const grant = await this.findUsableGrantByToken(input.grantToken, this.prisma)
    this.assertGrantMatches(input, grant)
    return grant
  }

  async consumeGrantByToken(
    input: {
      method: AuthMethodName
      email?: string
      provider?: AuthProvider
      grantToken?: string
    },
    tx: RegistrationInviteGrantClient = this.prisma,
  ): Promise<void> {
    const grant = await this.assertGrantReady(input)

    if (!grant) {
      return
    }

    await this.consumeGrant(grant.id, tx)
  }

  async consumeGrantById(
    input: {
      method: AuthMethodName
      provider?: AuthProvider
      grantId: string | null
    },
    tx: RegistrationInviteGrantClient = this.prisma,
  ): Promise<void> {
    if (!(await this.systemAuthService.isRegistrationInviteCodeRequired(input.method))) {
      return
    }

    if (!input.grantId) {
      throw new RegistrationInviteRequiredException()
    }

    const grant = await tx.registrationInviteGrant.findFirst({
      where: {
        id: input.grantId,
        consumedAt: null,
        deletedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
    })

    this.assertGrantMatches(input, grant)
    await this.consumeGrant(input.grantId, tx)
  }

  private async findUsableGrantByToken(
    grantToken: string,
    tx: RegistrationInviteGrantClient,
  ): Promise<RegistrationInviteGrant | null> {
    return tx.registrationInviteGrant.findFirst({
      where: {
        tokenHash: sha256Hex(grantToken.trim()),
        consumedAt: null,
        deletedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
    })
  }

  private async consumeGrant(
    grantId: string,
    tx: RegistrationInviteGrantClient,
  ): Promise<void> {
    const consumed = await tx.registrationInviteGrant.updateMany({
      where: {
        id: grantId,
        consumedAt: null,
        deletedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      data: {
        consumedAt: new Date(),
      },
    })

    if (consumed.count !== 1) {
      throw new BadRequestException('邀请码凭证已失效，请重新验证')
    }
  }

  private assertGrantMatches(
    input: {
      method: AuthMethodName
      email?: string
      provider?: AuthProvider
    },
    grant: RegistrationInviteGrant | null,
  ): asserts grant is RegistrationInviteGrant {
    if (!grant || grant.method !== input.method) {
      throw new BadRequestException('邀请码凭证已失效，请重新验证')
    }

    if (input.method === AUTH_METHOD.PASSWORD) {
      const normalizedEmail = this.resolveNormalizedEmail(input.method, input.email)

      if (grant.normalizedEmail !== normalizedEmail) {
        throw new BadRequestException('邀请码凭证已失效，请重新验证')
      }

      return
    }

    const provider = input.provider ?? resolveGrantProvider(input.method)

    if (!provider || grant.provider !== provider) {
      throw new BadRequestException('邀请码凭证已失效，请重新验证')
    }
  }

  private resolveNormalizedEmail(method: AuthMethodName, email: string | undefined): string | null {
    if (method !== AUTH_METHOD.PASSWORD) {
      return null
    }

    if (!email) {
      throw new BadRequestException('邮箱注册需要提供邮箱')
    }

    return normalizeEmail(email)
  }
}

function resolveGrantProvider(method: AuthMethodName): AuthProvider | null {
  if (method === AUTH_METHOD.GITHUB) {
    return AuthProvider.GITHUB
  }

  if (method === AUTH_METHOD.LINUX_DO) {
    return AuthProvider.LINUX_DO
  }

  if (method === AUTH_METHOD.GOOGLE) {
    return AuthProvider.GOOGLE
  }

  return null
}
