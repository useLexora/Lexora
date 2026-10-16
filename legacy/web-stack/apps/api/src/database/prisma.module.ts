import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createPrismaService, PrismaService } from './prisma.service'

@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: (configService: ConfigService) => createPrismaService(configService),
      inject: [ConfigService],
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
