import type { PrismaClient } from '@prisma/client'
import process from 'node:process'
import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { PrismaService } from '../database/prisma.service'
import { hashPassword } from '../modules/auth/password.utils'
import { generateSystemAdminInitialPassword } from '../modules/auth/system-admin-password.utils'
import { CliModule } from './cli.module'

const SYSTEM_AUTH_CONFIG_ID = 'default'
const logger = new Logger('ResetSystemAdminPasswordCommand')

interface SystemAdminUser {
  id: string
  email: string | null
  displayName: string
  deletedAt: Date | null
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(CliModule)
  const configService = app.get(ConfigService)
  const prisma = app.get(PrismaService).$bypass

  try {
    const systemAdminUser = await resolveSystemAdminUser(
      prisma,
      configService.getOrThrow<string>('bootstrap.systemAdminEmail'),
    )

    if (systemAdminUser.deletedAt) {
      throw new Error(`系统管理员用户已删除: ${systemAdminUser.email ?? systemAdminUser.id}`)
    }

    const now = new Date()
    const initialPassword = generateSystemAdminInitialPassword()
    const passwordHash = await hashPassword(initialPassword)

    const result = await prisma.$transaction(async (tx) => {
      await tx.localCredential.upsert({
        where: {
          userId: systemAdminUser.id,
        },
        create: {
          userId: systemAdminUser.id,
          passwordHash,
          mustChangePassword: true,
          emailVerifiedAt: now,
          passwordUpdatedAt: now,
        },
        update: {
          passwordHash,
          mustChangePassword: true,
          emailVerifiedAt: now,
          passwordUpdatedAt: now,
          deletedAt: null,
        },
      })

      const revokedTokens = await tx.authRefreshToken.updateMany({
        where: {
          userId: systemAdminUser.id,
          revokedAt: null,
          deletedAt: null,
        },
        data: {
          revokedAt: now,
        },
      })

      return {
        revokedRefreshTokenCount: revokedTokens.count,
      }
    })

    logger.log(`System admin password reset: ${systemAdminUser.email ?? systemAdminUser.id}`)
    logger.log(`Display name: ${systemAdminUser.displayName}`)
    logger.warn(`System admin initial password: ${initialPassword}`)
    logger.log('Must change password: true')
    logger.log(`Revoked refresh tokens: ${result.revokedRefreshTokenCount}`)
  }
  finally {
    await app.close()
  }
}

async function resolveSystemAdminUser(
  prisma: PrismaClient,
  fallbackSystemAdminEmail: string,
): Promise<SystemAdminUser> {
  const config = await prisma.systemAuthConfig.findUnique({
    where: {
      id: SYSTEM_AUTH_CONFIG_ID,
    },
    include: {
      systemAdminUser: {
        select: {
          id: true,
          email: true,
          displayName: true,
          deletedAt: true,
        },
      },
    },
  })

  if (config?.systemAdminUser) {
    return config.systemAdminUser
  }

  const systemAdminEmail = config?.systemAdminEmail ?? fallbackSystemAdminEmail
  const user = await prisma.user.findUnique({
    where: {
      email: systemAdminEmail,
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      deletedAt: true,
    },
  })

  if (!user) {
    throw new Error(`系统管理员用户不存在: ${systemAdminEmail}`)
  }

  return user
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
