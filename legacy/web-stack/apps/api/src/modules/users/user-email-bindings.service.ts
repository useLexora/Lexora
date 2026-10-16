import type { ConfirmBindEmailRequest } from '@haohaoxue/lexora-contracts'
import { randomInt } from 'node:crypto'
import { API_ERROR_CODE } from '@haohaoxue/lexora-contracts'
import { resolveLanguagePreference } from '@haohaoxue/lexora-shared'
import {
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../../database/prisma.service'
import { apiBadRequest } from '../../utils/api-error'
import { normalizeEmail } from '../../utils/email'
import { sha256Hex } from '../../utils/hash'
import { AuthMailerService } from '../auth/auth-mailer.service'
import { hashPassword } from '../auth/password.utils'
import { SystemEmailService } from '../system-email/system-email.service'
import {
  BIND_EMAIL_CODE_RESEND_INTERVAL_MS,
  BIND_EMAIL_CODE_TTL_SECONDS,
  MAX_BIND_EMAIL_CODE_ATTEMPTS,
} from './users.constants'
import { mapLanguagePreference } from './users.utils'

@Injectable()
export class UserEmailBindingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authMailerService: AuthMailerService,
    private readonly systemEmailService: SystemEmailService,
  ) {}

  async requestBindEmailCode(
    userId: string,
    rawEmail: string,
    preferredLanguages: readonly string[] = [],
  ): Promise<{ requested: boolean }> {
    if (!(await this.systemEmailService.isEnabled())) {
      throw apiBadRequest(API_ERROR_CODE.EMAIL_BINDING_UNAVAILABLE)
    }

    const email = normalizeEmail(rawEmail)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        preference: {
          select: {
            languagePreference: true,
          },
        },
      },
    })

    if (!user) {
      throw new NotFoundException(`User "${userId}" not found`)
    }

    if (user.email === email) {
      throw apiBadRequest(API_ERROR_CODE.EMAIL_ALREADY_BOUND)
    }

    await this.assertEmailAvailable(userId, email)

    const existingCode = await this.prisma.userEmailVerificationCode.findFirst({
      where: {
        userId,
        email,
        purpose: 'BIND_EMAIL',
        consumedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    })

    if (existingCode && Date.now() - existingCode.lastSentAt.getTime() < BIND_EMAIL_CODE_RESEND_INTERVAL_MS) {
      throw apiBadRequest(API_ERROR_CODE.EMAIL_CODE_RATE_LIMITED)
    }

    await this.prisma.userEmailVerificationCode.updateMany({
      where: {
        userId,
        purpose: 'BIND_EMAIL',
        consumedAt: null,
      },
      data: {
        consumedAt: new Date(),
      },
    })

    const code = String(randomInt(100000, 1000000))

    await this.prisma.userEmailVerificationCode.create({
      data: {
        userId,
        email,
        purpose: 'BIND_EMAIL',
        codeHash: sha256Hex(code),
        expiresAt: new Date(Date.now() + BIND_EMAIL_CODE_TTL_SECONDS * 1000),
      },
    })

    await this.authMailerService.sendBindEmailCodeEmail({
      email,
      code,
      language: resolveLanguagePreference(
        mapLanguagePreference(user.preference?.languagePreference),
        preferredLanguages,
      ),
    })

    return { requested: true }
  }

  async confirmBindEmail(userId: string, payload: ConfirmBindEmailRequest): Promise<void> {
    const email = normalizeEmail(payload.email)
    const code = payload.code.trim()
    const latestCode = await this.prisma.userEmailVerificationCode.findFirst({
      where: {
        userId,
        email,
        purpose: 'BIND_EMAIL',
        consumedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    })

    if (!latestCode || latestCode.expiresAt.getTime() <= Date.now()) {
      throw apiBadRequest(API_ERROR_CODE.EMAIL_CODE_EXPIRED)
    }

    if (latestCode.attemptCount >= MAX_BIND_EMAIL_CODE_ATTEMPTS) {
      throw apiBadRequest(API_ERROR_CODE.EMAIL_CODE_ATTEMPT_LIMIT_EXCEEDED)
    }

    if (latestCode.codeHash !== sha256Hex(code)) {
      await this.prisma.userEmailVerificationCode.update({
        where: { id: latestCode.id },
        data: {
          attemptCount: {
            increment: 1,
          },
        },
      })
      throw apiBadRequest(API_ERROR_CODE.EMAIL_CODE_INVALID)
    }

    await this.assertEmailAvailable(userId, email)

    await this.prisma.$transaction(async (tx) => {
      const currentUser = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          localCredential: {
            select: {
              userId: true,
            },
          },
        },
      })

      if (!currentUser) {
        throw new NotFoundException(`User "${userId}" not found`)
      }

      const consumed = await tx.userEmailVerificationCode.updateMany({
        where: {
          id: latestCode.id,
          consumedAt: null,
        },
        data: {
          consumedAt: new Date(),
        },
      })

      if (consumed.count !== 1) {
        throw apiBadRequest(API_ERROR_CODE.EMAIL_CODE_EXPIRED)
      }

      await tx.user.update({
        where: { id: userId },
        data: {
          email,
        },
      })

      if (currentUser.localCredential) {
        await tx.localCredential.update({
          where: { userId },
          data: {
            emailVerifiedAt: new Date(),
          },
        })
        return
      }

      const password = payload.newPassword

      if (!password) {
        throw apiBadRequest(API_ERROR_CODE.FIRST_EMAIL_BINDING_PASSWORD_REQUIRED)
      }

      await tx.localCredential.create({
        data: {
          userId,
          passwordHash: await hashPassword(password),
          emailVerifiedAt: new Date(),
          passwordUpdatedAt: new Date(),
        },
      })
    })
  }

  private async assertEmailAvailable(userId: string, email: string): Promise<void> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
      },
    })

    if (existingUser && existingUser.id !== userId) {
      throw apiBadRequest(API_ERROR_CODE.EMAIL_ALREADY_USED)
    }
  }
}
