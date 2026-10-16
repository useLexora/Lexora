import type { ResolvedLanguagePreference } from '@haohaoxue/lexora-contracts'
import type { Prisma } from '@prisma/client'
import type { FastifyRequest } from 'fastify'
import type { TokenExchangeResult } from './auth.interface'
import { randomInt } from 'node:crypto'
import { API_ERROR_CODE, AUTH_METHOD } from '@haohaoxue/lexora-contracts'
import { LANGUAGE_PREFERENCE } from '@haohaoxue/lexora-contracts/user/constants'
import {
  Injectable,
} from '@nestjs/common'
import { PrismaService } from '../../database/prisma.service'
import { apiBadRequest } from '../../utils/api-error'
import { normalizeEmail } from '../../utils/email'
import { sha256Hex } from '../../utils/hash'
import { resolveUniqueUserCode } from '../users/users.utils'
import { PersonalWorkspacesService } from '../workspaces/personal-workspaces.service'
import { AuthMailerService } from './auth-mailer.service'
import { AuthSessionsService } from './auth-sessions.service'
import {
  REGISTRATION_EMAIL_VERIFICATION_RESEND_INTERVAL_MS,
  REGISTRATION_EMAIL_VERIFICATION_TTL_SECONDS,
} from './auth.constants'
import { hashPassword } from './password.utils'
import { RegistrationInviteGrantsService } from './registration-invite-grants.service'
import { SystemAuthService } from './system-auth.service'

@Injectable()
export class AuthRegistrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemAuthService: SystemAuthService,
    private readonly authMailerService: AuthMailerService,
    private readonly personalWorkspacesService: PersonalWorkspacesService,
    private readonly authSessionsService: AuthSessionsService,
    private readonly registrationInviteGrantsService: RegistrationInviteGrantsService,
  ) {}

  async requestEmailVerification(
    email: string,
    registrationInviteGrantToken?: string,
    language: ResolvedLanguagePreference = LANGUAGE_PREFERENCE.EN_US,
  ): Promise<void> {
    await this.systemAuthService.assertRegistrationAllowed(AUTH_METHOD.PASSWORD)

    const normalizedEmail = normalizeEmail(email)
    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    })

    if (existingUser) {
      throw apiBadRequest(API_ERROR_CODE.REGISTRATION_EMAIL_EXISTS)
    }

    await this.registrationInviteGrantsService.assertGrantReady({
      method: AUTH_METHOD.PASSWORD,
      email: normalizedEmail,
      grantToken: registrationInviteGrantToken,
    })

    const latestVerification = await this.prisma.authEmailVerificationToken.findFirst({
      where: {
        email: normalizedEmail,
        purpose: 'REGISTER_VERIFY',
        consumedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    })

    if (
      latestVerification
      && Date.now() - latestVerification.createdAt.getTime() < REGISTRATION_EMAIL_VERIFICATION_RESEND_INTERVAL_MS
    ) {
      throw apiBadRequest(API_ERROR_CODE.REGISTRATION_CODE_RATE_LIMITED)
    }

    await this.prisma.authEmailVerificationToken.updateMany({
      where: {
        email: normalizedEmail,
        purpose: 'REGISTER_VERIFY',
        consumedAt: null,
      },
      data: {
        consumedAt: new Date(),
      },
    })

    const code = String(randomInt(100000, 1000000))

    await this.prisma.authEmailVerificationToken.create({
      data: {
        email: normalizedEmail,
        tokenHash: sha256Hex(code),
        purpose: 'REGISTER_VERIFY',
        expiresAt: new Date(Date.now() + REGISTRATION_EMAIL_VERIFICATION_TTL_SECONDS * 1000),
      },
    })

    await this.authMailerService.sendRegistrationCodeEmail({
      email: normalizedEmail,
      code,
      language,
    })
  }

  async registerWithPassword(
    email: string,
    code: string,
    displayName: string,
    password: string,
    request: FastifyRequest,
    registrationInviteGrantToken?: string,
  ): Promise<TokenExchangeResult> {
    const normalizedDisplayName = displayName.trim()

    if (!normalizedDisplayName.length) {
      throw apiBadRequest(API_ERROR_CODE.DISPLAY_NAME_REQUIRED)
    }

    await this.systemAuthService.assertRegistrationAllowed(AUTH_METHOD.PASSWORD)
    const passwordHash = await hashPassword(password)

    const user = await this.prisma.$transaction(async (tx) => {
      const { email: verifiedEmail } = await this.consumeRegistrationVerificationCode(email, code, tx)
      const existingUser = await tx.user.findUnique({
        where: { email: verifiedEmail },
        select: { id: true },
      })

      if (existingUser) {
        throw apiBadRequest(API_ERROR_CODE.REGISTRATION_EMAIL_EXISTS)
      }

      await this.registrationInviteGrantsService.consumeGrantByToken({
        method: AUTH_METHOD.PASSWORD,
        email: verifiedEmail,
        grantToken: registrationInviteGrantToken,
      }, tx)

      const userCode = await resolveUniqueUserCode({
        isUserCodeTaken: async candidate =>
          Boolean(await tx.user.findUnique({
            where: { userCode: candidate },
            select: { id: true },
          })),
      })

      const createdUser = await tx.user.create({
        data: {
          email: verifiedEmail,
          displayName: normalizedDisplayName,
          userCode,
        },
      })

      await this.personalWorkspacesService.provisionPersonalWorkspaceForUser({
        userId: createdUser.id,
        userCode: createdUser.userCode,
      }, tx)

      await tx.localCredential.create({
        data: {
          userId: createdUser.id,
          passwordHash,
          emailVerifiedAt: new Date(),
          passwordUpdatedAt: new Date(),
        },
      })

      return createdUser
    })

    return this.authSessionsService.issueAuthSession(user.id, request)
  }

  private async consumeRegistrationVerificationCode(
    email: string,
    code: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<{ email: string }> {
    const normalizedEmail = normalizeEmail(email)
    const normalizedCode = code.trim()
    const token = await tx.authEmailVerificationToken.findFirst({
      where: {
        email: normalizedEmail,
        purpose: 'REGISTER_VERIFY',
        consumedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    })

    if (!token || token.expiresAt.getTime() <= Date.now()) {
      throw apiBadRequest(API_ERROR_CODE.EMAIL_CODE_EXPIRED)
    }

    if (token.tokenHash !== sha256Hex(normalizedCode)) {
      throw apiBadRequest(API_ERROR_CODE.EMAIL_CODE_INVALID)
    }

    const consumed = await tx.authEmailVerificationToken.updateMany({
      where: {
        id: token.id,
        consumedAt: null,
      },
      data: {
        consumedAt: new Date(),
      },
    })

    if (consumed.count !== 1) {
      throw apiBadRequest(API_ERROR_CODE.EMAIL_CODE_EXPIRED)
    }

    return {
      email: token.email,
    }
  }
}
