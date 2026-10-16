import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { softDeleteExtension } from './prisma.extension'

export abstract class PrismaService extends PrismaClient {
  abstract readonly $bypass: PrismaClient
}

export function createPrismaService(configService: ConfigService): PrismaService & OnModuleInit & OnModuleDestroy {
  const base = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: configService.getOrThrow<string>('database.url'),
    }),
  })
  const extended = base.$extends(softDeleteExtension)

  return new Proxy(extended, {
    get(target, prop) {
      if (prop === '$bypass')
        return base
      if (prop === 'onModuleInit')
        return () => base.$connect()
      if (prop === 'onModuleDestroy')
        return () => base.$disconnect()
      return Reflect.get(target, prop)
    },
  }) as unknown as PrismaService & OnModuleInit & OnModuleDestroy
}
